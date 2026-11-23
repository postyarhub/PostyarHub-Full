#!/usr/bin/env node
'use strict';

/**
 * Diagnostic and self-healing tool for PostYar multi-channel delivery.
 * Usage:
 *   node scripts/diagnose-postyar.cjs
 *   node scripts/diagnose-postyar.cjs --retry-failed
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// 1. Load environment
const loadEnvPath = path.join(__dirname, '..', 'config', 'load-env.cjs');
if (fs.existsSync(loadEnvPath)) {
  require(loadEnvPath);
}

const appRoot = path.join(__dirname, '..', 'app');
const runtimeNodeModules = path.join(__dirname, '..', 'api', 'node_modules');
const fallbackNodeModules = path.join(appRoot, 'node_modules');
const paths = [runtimeNodeModules, fallbackNodeModules, process.env.NODE_PATH].filter(Boolean);
process.env.NODE_PATH = paths.join(path.delimiter);
require('module')._initPaths();

async function run() {
  console.log('====================================================');
  console.log('🔍 ممیزی و عیب‌یابی سامانه ارسال کانال‌های پُست‌یار');
  console.log('====================================================\n');

  // 1. Check Node.js
  console.log(`[1] نسخه نود: ${process.version} (مسیر: ${process.execPath})`);

  // 2. Check compiled dist files
  console.log('\n[2] بررسی وضعیت فایل‌های کامپایل‌شده (dist):');
  const postAggregatePath = path.join(appRoot, 'dist', 'core', 'post-aggregate.js');
  const deliveryWorkerPath = path.join(appRoot, 'dist', 'workers', 'delivery.worker.js');
  
  if (fs.existsSync(postAggregatePath)) {
    const aggContent = fs.readFileSync(postAggregatePath, 'utf8');
    const hasFix = aggContent.includes('open > 0');
    console.log(`   - post-aggregate.js: ${hasFix ? '✅ اصلاح شده (open > 0 بررسی می‌شود)' : '❌ نسخه قدیمی (نیاز به استخراج v114 دارد)'}`);
  } else {
    console.log(`   - post-aggregate.js: ❌ یافت نشد!`);
  }

  if (fs.existsSync(deliveryWorkerPath)) {
    const workerContent = fs.readFileSync(deliveryWorkerPath, 'utf8');
    const hasFix = workerContent.includes("post.state === 'CANCELLED' || post.state === 'DRAFT'");
    console.log(`   - delivery.worker.js: ${hasFix ? '✅ اصلاح شده (لغو کاذب هدف‌ها برطرف شده)' : '❌ نسخه قدیمی (نیاز به استخراج v114 دارد)'}`);
  } else {
    console.log(`   - delivery.worker.js: ❌ یافت نشد!`);
  }

  // 3. Check Worker Process Status
  console.log('\n[3] وضعیت پردازه ورکر پس‌زمینه (postyar-worker):');
  let workerRunning = false;
  let workerPids = [];
  try {
    const pidsOutput = execSync('pgrep -u "$(id -u)" -x postyar-worker 2>/dev/null || true', { encoding: 'utf8' }).trim();
    if (pidsOutput) {
      workerPids = pidsOutput.split(/\s+/).filter(Boolean);
      workerRunning = workerPids.length > 0;
    }
  } catch {}

  if (workerRunning) {
    console.log(`   ✅ پردازه ورکر فعال است. PID(ها): ${workerPids.join(', ')}`);
  } else {
    console.log(`   ⚠️ هیچ پردازه ورکری در حال اجرا نیست! برای فعال‌سازی باید ./workers/restart-worker.sh اجرا شود.`);
  }

  // 4. Check Database and Recent Posts
  console.log('\n[4] بررسی دیتابیس و وضعیت آخرین پست‌ها و کانال‌ها:');
  try {
    const { getDb } = require(path.join(appRoot, 'dist', 'db', 'client.js'));
    const { posts, postTargets, channels } = require(path.join(appRoot, 'dist', 'db', 'schema.js'));
    const { desc, eq } = require('drizzle-orm');
    const db = getDb();

    const recentPosts = await db.select({
      id: posts.id,
      tenantId: posts.tenantId,
      title: posts.title,
      state: posts.state,
      createdAt: posts.createdAt,
      publishedAt: posts.publishedAt,
    }).from(posts).orderBy(desc(posts.createdAt)).limit(5);

    const retryArg = process.argv.includes('--retry-failed');
    let autoRecovered = 0;

    for (const p of recentPosts) {
      console.log(`\n   📌 پست [${p.id}]: ${p.title || '(بدون عنوان)'} | وضعیت کلی: ${p.state} | ایجاد: ${p.createdAt.toISOString()}`);
      
      const targets = await db.select({
        id: postTargets.id,
        platform: channels.platform,
        channelTitle: channels.title,
        channelRef: channels.channelRef,
        state: postTargets.state,
        attempts: postTargets.attempts,
        errorCode: postTargets.errorCode,
        errorMessage: postTargets.errorMessage,
        sentAt: postTargets.sentAt,
      })
      .from(postTargets)
      .innerJoin(channels, eq(channels.id, postTargets.channelId))
      .where(eq(postTargets.postId, p.id));

      for (const t of targets) {
        const statusIcon = t.state === 'SENT' ? '✅' : t.state === 'FAILED' ? '❌' : t.state === 'CANCELLED' ? '🚫' : '⏳';
        console.log(`      ${statusIcon} [${t.platform}] ${t.channelTitle || t.channelRef}: وضعیت=${t.state} | تلاش=${t.attempts} ${t.errorMessage ? '| خطا=' + t.errorMessage : ''}`);
        
        // Check if incorrectly cancelled
        if (t.state === 'CANCELLED' && p.state !== 'CANCELLED') {
          console.log(`         ⚠️ این کانال لغو شده در حالی که پست لغو نشده بود!`);
          if (retryArg) {
            const { retryTarget } = require(path.join(appRoot, 'dist', 'modules', 'publishing', 'post.service.js'));
            try {
              await retryTarget(p.tenantId, t.id, { actorId: p.tenantId, actorRole: 'admin' });
              console.log(`         🚀 ارسال مجدد برای این کانال در صف قرار گرفت.`);
              autoRecovered++;
            } catch (err) {
              console.log(`         ❌ خطا در فراخوانی سرویس: ${err.message}`);
              // Direct fallback recovery
              try {
                const { enqueue } = require(path.join(appRoot, 'dist', 'queue', 'queues.js'));
                const { inArray, and } = require('drizzle-orm');
                await db.update(postTargets)
                  .set({ state: 'PENDING', attempts: 0, nextRetryAt: null, errorCode: null, errorMessage: null })
                  .where(eq(postTargets.id, t.id));
                await db.update(posts)
                  .set({ state: 'QUEUED' })
                  .where(and(eq(posts.id, p.id), inArray(posts.state, ['FAILED', 'PARTIAL', 'PUBLISHED', 'PUBLISHING'])));
                await enqueue('delivery', 'deliver', { targetId: t.id }, { jobId: `recover-cli:${t.id}:${Date.now()}` });
                console.log(`         ✅ بازیابی مستقیم در صف انجام شد.`);
                autoRecovered++;
              } catch (directErr) {
                console.log(`         ❌ خطا در بازیابی مستقیم: ${directErr.message}`);
              }
            }
          }
        }
      }
    }

    if (!retryArg) {
      console.log('\n   💡 نکته: برای ارسال مجدد خودکار کانال‌های لغو/ناموفق این پست‌ها، می‌توانید دستور زیر را اجرا کنید:');
      console.log('      node scripts/diagnose-postyar.cjs --retry-failed');
    }
  } catch (dbErr) {
    console.log(`   ❌ خطا در اتصال یا استعلام دیتابیس: ${dbErr.message}`);
  }

  // 5. Worker log tail
  console.log('\n[5] آخرین لاگ‌های ورکر (logs/worker.log):');
  const workerLogPath = path.join(__dirname, '..', 'logs', 'worker.log');
  if (fs.existsSync(workerLogPath)) {
    try {
      const logContent = fs.readFileSync(workerLogPath, 'utf8');
      const lines = logContent.trim().split('\n').slice(-15);
      console.log(lines.join('\n'));
    } catch (e) {
      console.log(`   خطا در خواندن فایل لاگ: ${e.message}`);
    }
  } else {
    console.log('   فایل logs/worker.log یافت نشد.');
  }

  console.log('\n====================================================');
  console.log('پایان گزارش عیب‌یابی.');
  console.log('====================================================');
  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error in diagnostic tool:', err);
  process.exit(1);
});

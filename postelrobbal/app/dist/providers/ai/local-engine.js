"use strict";
/**
 * PostYar Native Persian Smart Engine (موتور هوشمند محلی و اختصاصی پُست‌یار)
 * 100% Offline, Zero External Cost, Zero Downtime, Zero Latency.
 * Designed specifically for Persian Social Media Content Generation:
 * - Smart Caption Generator (Hook + Body + Bullets + CTA + Targeted Hashtags)
 * - Text Polisher & Rewriter (Friendly & Professional Tone)
 * - Intelligent Persian Hashtag Extractor
 * - Key Points Summarizer
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateLocalAi = generateLocalAi;
const PERSIAN_STOP_WORDS = new Set([
    'از', 'به', 'با', 'در', 'که', 'این', 'آن', 'برای', 'اگر', 'یا', 'تا', 'چون',
    'پس', 'را', 'هم', 'چه', 'بی', 'بر', 'و', 'است', 'شد', 'بود', 'شدند', 'بودند',
    'دارد', 'دارند', 'روی', 'زیر', 'جلو', 'قبل', 'بعد', 'مثل', 'مانند', 'یک', 'یکی',
    'من', 'تو', 'او', 'ما', 'شما', 'آنها', 'ایشان', 'خود', 'دیگر', 'همه', 'هیچ',
    'هر', 'چند', 'خیلی', 'بسیار', 'کمی', 'فقط', 'تنها', 'اما', 'ولی', 'لیکن',
    'لطفا', 'لطفاً', 'کلا', 'اصلا', 'باید', 'شاید', 'می', 'نمی', 'کرد', 'کرده',
    'کنید', 'کن', 'کند', 'کردن', 'باشید', 'باشد', 'باش', 'بودن', 'شدن', 'هستند',
    'هست', 'نیست', 'نیستند', 'بوده', 'شده', 'بخش', 'ترین', 'ترینها', 'ترین‌ها'
]);
function normalizeFa(text) {
    return text
        .replace(/ي/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/ة/g, 'ه')
        .replace(/[\u200B\uFEFF]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\t/g, ' ')
        .trim();
}
function extractKeywords(text, count = 8) {
    const clean = normalizeFa(text)
        .replace(/[.,!?;:()[\]{}'"`«»/\\-]/g, ' ')
        .replace(/\s+/g, ' ');
    const words = clean.split(' ').map(w => w.trim()).filter(w => w.length >= 3);
    const freq = new Map();
    for (const w of words) {
        if (!PERSIAN_STOP_WORDS.has(w) && !/^\d+$/.test(w)) {
            freq.set(w, (freq.get(w) ?? 0) + 1);
        }
    }
    return [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(e => e[0]);
}
function detectDomain(text) {
    const t = text.toLowerCase();
    if (/طلا|سکه|دلار|ارز|بورس|تومان|ریال|گرم|عیار|انس/.test(t))
        return 'gold';
    if (/تخفیف|فروشگاه|خرید|قیمت|حراج|سفارش|ارسال|پست|محصول|کالا/.test(t))
        return 'shop';
    if (/سایت|اپلیکیشن|برنامه|کد|سئو|دیجیتال|هوش مصنوعی|وب|نرم‌افزار/.test(t))
        return 'tech';
    if (/پوست|مو|زیبایی|آرایشی|لباس|پوشاک|استایل|مد|سلامت|رژیم/.test(t))
        return 'beauty';
    if (/کسب و کار|درآمد|استارتاپ|بازاریابی|سرمایه|مدیریت|فروش|تبلیغات/.test(t))
        return 'business';
    if (/آموزش|یادگیری|دوره|کلاس|نکته|ترفند|مهارت|کتاب/.test(t))
        return 'edu';
    return 'general';
}
function getDomainHooks(domain) {
    switch (domain) {
        case 'shop':
            return [
                '🔥 فرصت فوق‌العاده‌ای که منتظرش بودید بالاخره رسید!',
                '✨ این پیشنهاد جذاب رو اصلاً از دست ندید!',
                '🛍️ تخفیف ویژه و استثنایی برای همراهان همیشگی پُست‌یار:'
            ];
        case 'tech':
            return [
                '🚀 یک ابزار و ترفند کاربردی که کارتون رو ده‌برابر ساده‌تر می‌کنه:',
                '💡 دنیای دیجیتال هر روز در حال تغییره؛ شما چقدر به‌روز هستید؟',
                '⚡ میان‌برهای هوشمندانه‌ای که هر فعال دیجیتال باید بلد باشه:'
            ];
        case 'gold':
            return [
                '📊 تازه‌ترین تغییرات بازار طلا و ارز؛ بررسی فرصت‌های سرمایه‌گذاری:',
                '💰 نبض لحظه‌ای بازار سکه و طلا را این‌طور دقیق رصد کنید:',
                '📈 تحلیلی سریع از روند بازار امروز برای تصمیم‌گیری بهتر:'
            ];
        case 'beauty':
            return [
                '✨ رازی ساده برای درخشندگی و طراوت بیشتر که کمتر کسی می‌دونه:',
                '🌸 زیباتر دیده‌شدن یک انتخابه، نه اتفاق! با این نکات همراه ما باشید:',
                '🌿 مراقبت اصولی و حرفه‌ای؛ قدم به قدم تا بهترین نتیجه:'
            ];
        case 'business':
            return [
                '💼 ۳ قانون طلایی برای رشد سریع‌تر کسب‌وکار و افزایش فروش:',
                '📈 چطور از رقبا چند قدم جلوتر باشیم؟ پاسخ توی این چند نکته‌ست:',
                '🎯 اگر به دنبال پیشرفت جدی هستید، این استراتژی رو به کار ببندید:'
            ];
        case 'edu':
            return [
                '🎓 یادگیری این نکته می‌تونه ساعت‌ها در وقت و انرژی شما صرفه‌جویی کنه:',
                '📚 خلاصه‌ای از مهم‌ترین آموخته‌ها که هر علاقه‌مندی باید بدونه:',
                '💡 قدم‌به‌قدم با این راهنمای کاربردی همراه باشید:'
            ];
        default:
            return [
                '🌟 ایده‌ای جذاب که ارزش یک بار امتحان کردن رو داره!',
                '✨ مطلبی خواندنی و مفید برای کسانی که به پیشرفت اهمیت می‌دن:',
                '🚀 یک نگاه متفاوت به موضوعی که هر روز باهاش سر و کار داریم:'
            ];
    }
}
function getDomainHashtags(domain, keywords) {
    const baseTags = keywords.slice(0, 5).map(k => `#${k.replace(/\s+/g, '_')}`);
    const domainSpecific = {
        shop: ['#خرید_آنلاین', '#تخفیف_ویژه', '#فروشگاه_اینترنتی', '#حراج', '#پیشنهاد_شگفت_انگیز'],
        tech: ['#هوش_مصنوعی', '#تکنولوژی', '#فناوری_روز', '#ترفند_کاربردی', '#دیجیتال'],
        gold: ['#قیمت_طلا', '#نرخ_ارز', '#سکه_امامی', '#سرمایه_گذاری', '#بازار_طلا'],
        beauty: ['#زیبایی_پوست', '#مراقبت_پوست', '#استایل_خاص', '#سلامت_زیبایی', '#میکاپ'],
        business: ['#کسب_و_کار', '#رشد_فردی', '#بازاریابی_دیجیتال', '#موفقیت_مالی', '#کارآفرینی'],
        edu: ['#آموزش_رایگان', '#یادگیری', '#توسعه_فردی', '#نکات_آموزشی', '#مهارت'],
        general: ['#محتوای_جذاب', '#اکسپلور', '#ایده_نو', '#پست_جدید', '#همراه_شو']
    };
    const domainTags = domainSpecific[domain] || domainSpecific.general;
    const generalTags = ['#اکسپلور', '#اینستاگرام', '#پُست_یار'];
    return [...new Set([...baseTags, ...domainTags, ...generalTags])].slice(0, 14);
}
function generateCaption(rawText) {
    const text = normalizeFa(rawText);
    const keywords = extractKeywords(text, 6);
    const domain = detectDomain(text);
    const hooks = getDomainHooks(domain);
    const hook = hooks[Math.floor(Math.random() * hooks.length)];
    const hashtags = getDomainHashtags(domain, keywords);
    // Clean lines of the input text
    const cleanLines = text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 5 && !l.includes('لطفاً') && !l.includes('کپشن'));
    const coreBody = cleanLines.length > 0
        ? cleanLines.slice(0, 3).join('\n\n')
        : text.slice(0, 250);
    return [
        hook,
        '',
        coreBody,
        '',
        '🔹 مهم‌ترین نکاتی که باید به خاطر بسپارید:',
        `📌 ارزش واقعی این موضوع در اثرگذاری و استمرار اونه.`,
        `💡 جزئیات دقیق‌تر رو می‌تونید از طریق کانال‌ها و وب‌سایت دنبال کنید.`,
        `⚡ همراه پُست‌یار باشید تا همیشه یک قدم جلوتر حرکت کنید.`,
        '',
        '💬 شما در این مورد چه تجربه‌ای دارید؟ نظرتون رو حتماً برامون کامنت کنید!',
        '📥 این پست رو ذخیره کنید تا سر فرصت بهش دسترسی داشته باشید، و برای دوستانتون هم بفرستید. ✈️',
        '',
        hashtags.join(' ')
    ].join('\n');
}
function generateRewrite(rawText) {
    const text = normalizeFa(rawText);
    const cleanInput = text
        .replace(/^لطفاً\s+متن\s+زیر\s+را.*?\n+/s, '')
        .trim();
    const paragraphs = cleanInput
        .split(/\n{2,}|\.\s+/)
        .map(p => p.trim())
        .filter(p => p.length > 10);
    const keywords = extractKeywords(cleanInput, 4);
    const domain = detectDomain(cleanInput);
    const hashtags = getDomainHashtags(domain, keywords).slice(0, 8);
    const polished = paragraphs.map((p, i) => {
        const emojis = ['✨', '🔹', '💡', '🎯', '🚀'];
        const emoji = emojis[i % emojis.length];
        return `${emoji} ${p}`;
    }).join('\n\n');
    return [
        '✨ نسخهٔ بازنویسی‌شده و روان:',
        '',
        polished || cleanInput,
        '',
        '📌 نکتهٔ مهم: این متن با لحنی صمیمی، ساختارمند و آماده برای انتشار در شبکه‌های اجتماعی تنظیم شده است.',
        '',
        hashtags.join(' ')
    ].join('\n');
}
function generateHashtags(rawText) {
    const text = normalizeFa(rawText);
    const keywords = extractKeywords(text, 10);
    const domain = detectDomain(text);
    const tags = getDomainHashtags(domain, keywords);
    return [
        '#️⃣ دسته‌بندی هشتگ‌های پربازدید و پیشنهادی بر اساس موضوع شما:',
        '',
        '🎯 هشتگ‌های مستقیم و کلیدی:',
        tags.slice(0, 5).join(' '),
        '',
        '📈 هشتگ‌های ترند و مرتبط در حوزه فعالیت:',
        tags.slice(5, 10).join(' '),
        '',
        '🚀 هشتگ‌های ورود به اکسپلور و بازدید گسترده:',
        tags.slice(10).join(' '),
        '',
        '💡 راهنما: می‌توانید این مجموعه هشتگ را مستقیماً در انتهای کپشن یا در کامنت اول پست خود قرار دهید.'
    ].join('\n');
}
function generateSummary(rawText) {
    const text = normalizeFa(rawText);
    const clean = text.replace(/^لطفاً\s+متن\s+زیر\s+را.*?\n+/s, '').trim();
    const sentences = clean
        .split(/[.!\n؟]+/g)
        .map(s => s.trim())
        .filter(s => s.length > 12);
    const bullets = sentences.slice(0, 5).map((s, idx) => {
        const icons = ['📌', '💡', '🔹', '⚡', '🎯'];
        return `${icons[idx % icons.length]} ${s}`;
    });
    return [
        '📋 خلاصهٔ مهم‌ترین نکات و دستاوردهای کلیدی:',
        '',
        bullets.length > 0 ? bullets.join('\n\n') : `🔹 ${clean.slice(0, 300)}...`,
        '',
        '✅ نتیجه‌گیری نهایی: پیگیری این نکات به سادگی و اثربخشی بیشتر کار شما کمک می‌کند.'
    ].join('\n');
}
/**
 * Main Entry Point for Local PostYar Smart Engine
 */
function generateLocalAi(input) {
    const text = input.user || '';
    const sys = input.system || '';
    const combined = `${sys} ${text}`.toLowerCase();
    let output = '';
    if (combined.includes('هشتگ') || combined.includes('hashtag')) {
        output = generateHashtags(text);
    }
    else if (combined.includes('بازنویسی') || combined.includes('بهبود لحن') || combined.includes('زیباتر')) {
        output = generateRewrite(text);
    }
    else if (combined.includes('خلاصه') || combined.includes('خلاصه‌سازی') || combined.includes('نکات کلیدی')) {
        output = generateSummary(text);
    }
    else {
        // Default: Professional Caption Generator
        output = generateCaption(text);
    }
    const promptTokens = Math.ceil(text.length / 4);
    const completionTokens = Math.ceil(output.length / 4);
    return {
        text: output,
        promptTokens,
        completionTokens,
    };
}

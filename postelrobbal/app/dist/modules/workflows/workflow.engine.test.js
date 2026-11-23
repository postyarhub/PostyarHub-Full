"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
vitest_1.vi.mock('../../db/client.js', () => ({ getDb: vitest_1.vi.fn() }));
vitest_1.vi.mock('../subscriptions/plan.service.js', () => ({ assertFeature: vitest_1.vi.fn() }));
vitest_1.vi.mock('../../core/events.js', () => ({ emitEvent: vitest_1.vi.fn() }));
vitest_1.vi.mock('../ai/ai.service.js', () => ({ aiProviderComplete: vitest_1.vi.fn() }));
let parseWorkflowDefinition;
let prepareWorkflowButtons;
(0, vitest_1.beforeAll)(async () => {
    ({ parseWorkflowDefinition, prepareWorkflowButtons } = await import('./workflow.engine.js'));
});
(0, vitest_1.describe)('workflow definition parser', () => {
    (0, vitest_1.it)('accepts supported steps and strips malformed children without crashing', () => {
        const def = parseWorkflowDefinition({
            trigger: { kind: 'MESSAGE_RECEIVED', keyword: 'سلام' },
            steps: [
                { type: 'MESSAGE', text: 'سلام {{name}}' },
                { type: 'BUTTONS', text: 'انتخاب کنید', buttons: [{ label: 'راهنما', url: 'https://postyarhub.ir/help' }] },
                { type: 'CONDITION', variable: 'text', operator: 'CONTAINS', value: 'قیمت', then: [{ type: 'MESSAGE', text: 'قیمت امروز' }, { nope: true }] },
                { nope: true },
            ],
        });
        (0, vitest_1.expect)(def).not.toBeNull();
        (0, vitest_1.expect)(def?.steps).toHaveLength(3);
        (0, vitest_1.expect)(def?.steps[0]).toEqual({ type: 'MESSAGE', text: 'سلام {{name}}' });
        (0, vitest_1.expect)(def?.steps[2]?.type).toBe('CONDITION');
    });
    (0, vitest_1.it)('preserves callback buttons for workflow sends and drops unusable entries', () => {
        (0, vitest_1.expect)(prepareWorkflowButtons([
            { label: 'URL', url: 'https://postyarhub.ir' },
            { label: 'Callback', callback: 'PLAN_BASIC' },
            { label: 'Empty' },
        ])).toEqual([
            { label: 'URL', url: 'https://postyarhub.ir' },
            { label: 'Callback', callback: 'PLAN_BASIC' },
        ]);
    });
    (0, vitest_1.it)('rejects a workflow with no valid executable steps', () => {
        (0, vitest_1.expect)(parseWorkflowDefinition({ trigger: { kind: 'MESSAGE_RECEIVED' }, steps: [{ nope: true }] })).toBeNull();
        (0, vitest_1.expect)(parseWorkflowDefinition(null)).toBeNull();
    });
});

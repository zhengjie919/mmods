import { test, expect } from 'claude-code/testing'

for (const [component, props, requestId] of [
  ['Pane', { bodyColumns: 34, isFocused: true, title: 'Toolbox' }, 'toolbox'],
  ['Pane', { bodyColumns: 90, isFocused: true, title: 'Toolbox' }, 'toolbox'],
  ['AbovePrompt', { hasSurvey: false }, undefined],
  ['UserMessage', { text: 'hello\nworld', origin: { kind: 'composer' }, isExpanded: false }, undefined],
] as const) {
  test(`renders ${component} ${props.bodyColumns ?? ''}`, async ($, on) => {
    on('clock.now', async () => ({ value: 1_000_000 }) as any)
    on('session.model', async () => ({ value: 'claude-sonnet-5-5' }) as any)
    on('session.usage', async () => ({ value: { startedAt: 1, cost: { usd: 1 }, context: { percent: 40, tokens: 1000, window: 5000 } } }) as any)
    on('store.get', async () => ({ value: undefined }) as any)
    const ui = await $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component, props, ...(requestId ? { requestId } : {}) } as any)
    expect(ui).toBeDefined()
    await ui.unmount()
  })
}

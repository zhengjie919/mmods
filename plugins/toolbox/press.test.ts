import { test, expect } from 'claude-code/testing'

test('the view button flips its label', async ($, on) => {
  on('clock.now', async () => ({ value: 1_000_000 }) as any)
  on('store.get', async () => ({ value: undefined }) as any)
  on('store.set', async () => ({ value: undefined }) as any)
  const ui = await $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
  expect(await ui.find({ key: '▸ toolbox' })).toBeDefined()
  expect(await ui.find({ key: 'view: full' })).toBeDefined()
  await ui.press({ key: 'view: full' })
  expect(await ui.find({ key: 'view: simple' })).toBeDefined()
  await ui.unmount()
})

// Full view hands a tool call to the engine's own drawing; simple view draws the one-line version.
test('simple view draws tool calls on one line', async ($, on) => {
  on('clock.now', async () => ({ value: 1_000_000 }) as any)
  on('store.get', async () => ({ value: undefined }) as any)
  on('store.set', async () => ({ value: undefined }) as any)
  const band = await $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
  await band.press({ key: 'view: full' })
  const props = { tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false }
  const ui = await $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component: 'ToolUse', props } as any)
  expect((await ui.find({ type: 'Text', text: 'B' }))?.text).toBe('B')
  await ui.unmount()
  await band.unmount()
})

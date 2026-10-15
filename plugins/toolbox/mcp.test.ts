import { test, expect } from 'claude-code/testing'
import { serversFromTools } from './hooks/mcp'

test('groups tools by server and flags servers that only offer sign-in', () => {
  const r = serversFromTools([
    'Read',
    'mcp__a__x',
    'mcp__a__y',
    'mcp__mcp-logging-prd__authenticate',
    'mcp__mcp-logging-prd__complete_authentication',
  ])
  expect(r).toEqual([
    { name: 'mcp-logging-prd', tools: 2, needsAuth: true },
    { name: 'a', tools: 2, needsAuth: false },
  ])
})

test('the pane renders the mcp tab', async ($, on) => {
  on('clock.now', async () => ({ value: 1_000_000 }) as any)
  on('session.model', async () => ({ value: 'claude-sonnet-5-5' }) as any)
  on('session.usage', async () => ({ value: { startedAt: 1, cost: { usd: 1 }, context: { percent: 40, tokens: 1000, window: 5000 } } }) as any)
  on('store.get', async () => ({ value: undefined }) as any)
  on('tool.list', async () => ({ value: [{ name: 'mcp__a__x', description: '', mcp: true }] }) as any)
  const ui = await $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component: 'Pane', requestId: 'toolbox', props: { bodyColumns: 34, isFocused: true, title: 'Toolbox' } } as any)
  expect(ui).toBeDefined()
  await ui.unmount()
})

// The MCP tab: one line per server the tool list shows, with a button to sign in where it needs it.
import { gradBtns, type Ui } from './gradient'
import { s } from './state'

export type McpActions = {
  setTab: (tab: 'main' | 'mcp') => void
  refreshMcp: () => void
  openMcp: () => void
  authMcp: (server: string) => void
}

// Servers from tool names `mcp__<server>__<tool>`. A server that lists only an `authenticate`
// tool is waiting for sign-in. A server that failed or is disabled lists nothing, so it is absent.
export function serversFromTools(names: string[]): { name: string; tools: number; needsAuth: boolean }[] {
  const by = new Map<string, string[]>()
  for (const n of names) {
    if (!n.startsWith('mcp__')) continue
    const rest = n.slice(5)
    const at = rest.indexOf('__')
    if (at < 0) continue
    const server = rest.slice(0, at)
    by.set(server, [...(by.get(server) ?? []), rest.slice(at + 2)])
  }
  return [...by.entries()]
    .map(([name, tools]) => ({
      name,
      tools: tools.length,
      needsAuth: tools.every(t => t === 'authenticate' || t === 'complete_authentication'),
    }))
    .sort((a, b) => Number(b.needsAuth) - Number(a.needsAuth) || a.name.localeCompare(b.name))
}

export function mcpView(ui: Ui, width: number, act: McpActions) {
  const { Box, Text } = ui
  const servers = s.mcp
  const need = servers?.filter(v => v.needsAuth) ?? []
  const w = Math.max(10, width - 14)
  return (
    <Box flexDirection="column">
      {gradBtns(ui, [
        { id: 'mcp-open', label: 'open /mcp', onPress: () => act.openMcp() },
        { id: 'mcp-refresh', label: s.isMcpBusy ? 'refreshing…' : 'refresh', onPress: () => act.refreshMcp() },
      ], width)}
      <Text>{' '}</Text>
      {servers === undefined ? (
        <Text dimColor>{'reading servers…'}</Text>
      ) : servers.length === 0 ? (
        <Text dimColor>{'no connected MCP servers'}</Text>
      ) : (
        servers.map(v => (
          <Box key={v.name}>
            <Text color={v.needsAuth ? '#fbbf24' : '#86efac'}>{'● '}</Text>
            <Text>{v.name.slice(0, w).padEnd(Math.min(w, 22))}</Text>
            <Text dimColor>{v.needsAuth ? ' needs auth' : ` ${v.tools} tools`}</Text>
          </Box>
        ))
      )}
      {need.length === 0 ? null : (
        <Box flexDirection="column">
          <Text>{' '}</Text>
          <Text dimColor>{'sign in'}</Text>
          {need.filter(v => s.authLinks[v.name] !== undefined).map(v => (
            <Box key={`link-${v.name}`} flexDirection="column">
              <Text dimColor>{`${v.name}: open this link`}</Text>
              <Text color="#67e8f9">{s.authLinks[v.name]}</Text>
            </Box>
          ))}
          {gradBtns(ui, need.map(v => ({ id: `auth-${v.name}`, label: v.name.slice(0, Math.max(6, width - 8)), onPress: () => act.authMcp(v.name) })), width)}
        </Box>
      )}
      <Text>{' '}</Text>
      <Text dimColor>{'failed or disabled servers do not show here: use open /mcp'}</Text>
    </Box>
  )
}

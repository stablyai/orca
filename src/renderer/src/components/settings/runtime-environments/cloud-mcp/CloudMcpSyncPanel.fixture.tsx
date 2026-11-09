import type {
  McpSyncServerRow,
  McpSyncStatus
} from '../../../../../../shared/agent-mcp-sync/mcp-sync-contract'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { CloudMcpSyncPanel, CloudMcpSyncSkeleton } from './CloudMcpSyncPanel'

function row(
  agent: McpSyncServerRow['agent'],
  name: string,
  target: string,
  patch: Partial<McpSyncServerRow>
): McpSyncServerRow {
  return {
    key: `${agent}:${name}`,
    agent,
    name,
    source: agent === 'codex' ? 'codex' : 'claude-user',
    transport: target.startsWith('http') ? 'http' : 'stdio',
    target,
    included: true,
    state: 'synced',
    ...patch
  }
}

const rows: McpSyncServerRow[] = [
  row('claude', 'linear', 'https://mcp.linear.app', { outcome: 'added' }),
  row('claude', 'sentry', 'https://mcp.sentry.dev', { outcome: 'unchanged', unreachable: true }),
  row('claude', 'everything', 'npx', {
    included: false,
    state: 'skipped',
    skipReason: 'turned-off'
  }),
  row('claude', 'figma-desktop', 'figma-mcp', { state: 'skipped', skipReason: 'local-command' }),
  row('claude', 'local-dev', 'http://localhost:3845', {
    state: 'skipped',
    skipReason: 'local-url'
  }),
  row('claude', 'py-tools', 'uvx', { state: 'skipped', outcome: 'command-missing' }),
  row('codex', 'github', 'npx', { state: 'skipped', outcome: 'kept-host' }),
  row('codex', 'memory', 'npx', { outcome: 'added' })
]

const base: McpSyncStatus = {
  environmentId: 'env-1',
  autoSync: true,
  running: false,
  lastSyncedAt: Date.UTC(2026, 10, 9, 16, 42),
  error: null,
  rows
}

const noop = (): void => {}
const panel = (status: McpSyncStatus, expanded: boolean) => (
  <CloudMcpSyncPanel
    status={status}
    expanded={expanded}
    onToggleExpanded={noop}
    onSyncNow={noop}
    onToggleServer={noop}
    onToggleAutoSync={noop}
  />
)

export const expanded = defineFixture({ width: 640, render: () => panel(base, true) })
export const collapsed = defineFixture({ width: 640, render: () => panel(base, false) })
export const syncing = defineFixture({
  width: 640,
  render: () => panel({ ...base, running: true }, false)
})
export const hostOutdated = defineFixture({
  width: 640,
  render: () =>
    panel(
      {
        ...base,
        lastSyncedAt: null,
        error: 'host-outdated',
        rows: rows.map((entry) =>
          entry.state === 'synced' ? { ...entry, state: 'pending', outcome: undefined } : entry
        )
      },
      false
    )
})
export const empty = defineFixture({
  width: 640,
  render: () => panel({ ...base, rows: [], lastSyncedAt: null }, false)
})
export const hostUnreachable = defineFixture({
  width: 640,
  render: () => panel({ ...base, error: 'host-unreachable' }, false)
})
export const loading = defineFixture({ width: 640, render: () => <CloudMcpSyncSkeleton /> })

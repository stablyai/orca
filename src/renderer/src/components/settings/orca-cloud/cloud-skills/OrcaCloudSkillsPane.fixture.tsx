import type {
  AgentConfigSyncRow,
  AgentConfigSyncStatus,
  CloudAgentConfigSyncPreferences
} from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { SettingsSection } from '../../section-layout/SettingsSection'
import type { OrcaCloudMcpWorkspace } from '../OrcaCloudMcpServersPane'
import { CloudSkillsSyncPanel, CloudSkillsSyncSkeleton } from './CloudSkillsSyncPanel'
import { CloudSkillsSyncSettingsView, OrcaCloudSkillsWorkspacesView } from './OrcaCloudSkillsPane'

const noop = (): void => {}

function row(
  kind: AgentConfigSyncRow['kind'],
  name: string,
  patch: Partial<AgentConfigSyncRow> = {}
): AgentConfigSyncRow {
  const scope = patch.scope ?? 'user'
  return {
    key: `${scope}:${kind}:${name}`,
    scope,
    kind,
    name,
    bytes: 2048,
    fileCount: 1,
    withheldFiles: 0,
    included: true,
    state: 'synced',
    outcome: 'added',
    ...patch
  }
}

const ROWS: AgentConfigSyncRow[] = [
  row('claude-skill', 'deploy-preview', { fileCount: 3 }),
  row('claude-skill', 'release-notes', { withheldFiles: 1 }),
  row('claude-command', 'review'),
  row('claude-command', 'frontend/component', { outcome: 'unchanged' }),
  row('agents-skill', 'playwright-cli', { digest: 'd-pw' }),
  row('claude-skill', 'playwright-cli', { digest: 'd-pw' }),
  row('codex-prompt', 'fix-ci', { outcome: 'unchanged' }),
  row('agents-skill', 'deploy-preview', { convertedFrom: 'user:claude-skill:deploy-preview' }),
  row('claude-skill', 'local-notes', { scope: 'project' }),
  row('claude-skill', 'scratch', {
    state: 'skipped',
    outcome: undefined,
    skipReason: 'turned-off'
  }),
  row('claude-skill', 'design-system', {
    scope: 'project',
    state: 'skipped',
    outcome: undefined,
    skipReason: 'in-repo'
  }),
  row('claude-skill', 'vendor-keys', {
    state: 'skipped',
    outcome: undefined,
    skipReason: 'secret'
  }),
  row('claude-skill', 'datasets', {
    state: 'skipped',
    outcome: undefined,
    skipReason: 'too-large'
  }),
  row('claude-command', 'ship', { state: 'skipped', outcome: 'kept-host' })
]

const STATUS: AgentConfigSyncStatus = {
  environmentId: 'env-1',
  running: false,
  lastSyncedAt: Date.UTC(2026, 10, 10, 16, 42),
  error: null,
  rows: ROWS
}
const EXCLUDED = new Set(['user:claude-skill:scratch'])

const ON: CloudAgentConfigSyncPreferences = {
  autoSync: true,
  shareAcrossAgents: true,
  excluded: [],
  optedIn: []
}
const OFF: CloudAgentConfigSyncPreferences = {
  autoSync: false,
  shareAcrossAgents: false,
  excluded: [],
  optedIn: []
}

const ONE: OrcaCloudMcpWorkspace[] = [
  { runtimeId: 'rt-1', name: 'acme/web · fix-login', environmentId: 'env-1' }
]

function page(
  preferences: CloudAgentConfigSyncPreferences,
  workspaces: OrcaCloudMcpWorkspace[] | null | 'failed',
  status: AgentConfigSyncStatus = STATUS,
  expanded = true,
  filter: 'all' | 'enabled' | 'disabled' = 'all',
  excluded: ReadonlySet<string> = EXCLUDED
): React.JSX.Element {
  return (
    <div className="bg-background px-8 py-6">
      <SettingsSection
        id="cloud-skills"
        title="Skills & commands"
        description="Skills and slash commands from Claude and Codex on this computer, synced to your cloud workspaces."
        forceVisible
        bodyClassName="rounded-none border-0 bg-transparent p-0 shadow-none"
      >
        <div className="space-y-5">
          <CloudSkillsSyncSettingsView preferences={preferences} onChange={noop} />
          <OrcaCloudSkillsWorkspacesView
            workspaces={workspaces}
            onRetry={noop}
            renderSync={(workspace) => (
              <CloudSkillsSyncPanel
                status={{ ...status, environmentId: workspace.environmentId }}
                excluded={excluded}
                initialFilter={filter}
                autoSync={preferences.autoSync}
                now={Date.UTC(2026, 10, 10, 16, 44)}
                expanded={expanded}
                onToggleExpanded={noop}
                onSyncNow={noop}
                onToggleItem={noop}
              />
            )}
          />
        </div>
      </SettingsSection>
    </div>
  )
}

export const synced = defineFixture({ width: 784, render: () => page(ON, ONE) })
export const collapsed = defineFixture({ width: 784, render: () => page(ON, ONE, STATUS, false) })
export const offNotSynced = defineFixture({
  width: 784,
  render: () =>
    page(
      OFF,
      ONE,
      {
        ...STATUS,
        lastSyncedAt: null,
        rows: ROWS.filter((entry) => !entry.convertedFrom).map((entry) =>
          entry.state === 'synced' ? { ...entry, state: 'pending', outcome: undefined } : entry
        )
      },
      true
    )
})
export const syncing = defineFixture({
  width: 784,
  render: () => page(ON, ONE, { ...STATUS, running: true }, false)
})
export const hostOutdated = defineFixture({
  width: 784,
  render: () =>
    page(
      ON,
      ONE,
      {
        ...STATUS,
        lastSyncedAt: null,
        error: 'host-outdated',
        rows: ROWS.map((entry) =>
          entry.state === 'synced' ? { ...entry, state: 'pending', outcome: undefined } : entry
        )
      },
      false
    )
})
export const hostUnreachable = defineFixture({
  width: 784,
  render: () => page(ON, ONE, { ...STATUS, error: 'host-unreachable' }, false)
})
export const noneFound = defineFixture({
  width: 784,
  render: () => page(ON, ONE, { ...STATUS, rows: [], lastSyncedAt: null }, false)
})
export const noneRunning = defineFixture({ width: 784, render: () => page(OFF, []) })
export const loadingWorkspaces = defineFixture({ width: 784, render: () => page(ON, null) })
export const loadFailed = defineFixture({ width: 784, render: () => page(ON, 'failed') })
export const panelLoading = defineFixture({
  width: 640,
  render: () => (
    <div className="bg-background p-6">
      <CloudSkillsSyncSkeleton />
    </div>
  )
})

/** A real profile: every skill installed for both agents, so Synced starts collapsed. */
const LONG_NAMES = [
  'agent-slack',
  'jira-tickets',
  'linear-tickets',
  'memory-leak-audit',
  'memory-leak-debugging',
  'orca-cli',
  'orca-computer-use',
  'orca-emulator',
  'orca-emulator-android',
  'orca-jira',
  'orca-linear',
  'orca-per-workspace-env',
  'orchestration'
]
const LONG_ROWS: AgentConfigSyncRow[] = [
  row('claude-command', 'acs-test-hello'),
  ...LONG_NAMES.flatMap((name) => [
    row('agents-skill', name, { digest: `d-${name}` }),
    row('claude-skill', name, { digest: `d-${name}` })
  ]),
  row('agents-skill', 'computer-use', { digest: 'd-cu' }),
  row('agents-skill', 'electron', { digest: 'd-el' }),
  row('agents-skill', 'find-skills', { digest: 'd-fs' }),
  row('agents-skill', 'visual-proof', { digest: 'd-vp' }),
  row('claude-skill', 'acs-test-secret', {
    state: 'skipped',
    outcome: undefined,
    skipReason: 'secret'
  })
]
const LONG = { ...STATUS, rows: LONG_ROWS }
const LONG_OFF = new Set(['user:agents-skill:electron', 'user:agents-skill:find-skills'])
export const longList = defineFixture({
  width: 784,
  render: () => page(ON, ONE, LONG, true, 'all', LONG_OFF)
})
export const longListEnabled = defineFixture({
  width: 784,
  render: () => page(ON, ONE, LONG, true, 'enabled', LONG_OFF)
})
export const longListDisabled = defineFixture({
  width: 784,
  render: () => page(ON, ONE, LONG, true, 'disabled', LONG_OFF)
})
export const emptyEnabled = defineFixture({
  width: 784,
  render: () => page(ON, ONE, LONG, true, 'enabled', new Set(LONG_ROWS.map((entry) => entry.key)))
})
export const emptyDisabled = defineFixture({
  width: 784,
  render: () => page(ON, ONE, LONG, true, 'disabled', new Set())
})
export const emptyAll = defineFixture({
  width: 784,
  render: () => page(ON, ONE, { ...STATUS, rows: [], lastSyncedAt: null }, true, 'all')
})

/** Subagents, output styles and memory (SK1): memory is opt-in; an older sandbox can't take them. */
const KIND_ROWS: AgentConfigSyncRow[] = [
  row('claude-agent', 'reviewer'),
  row('claude-agent', 'migrations', { scope: 'project' }),
  row('claude-output-style', 'terse', { outcome: 'unchanged' }),
  row('claude-memory', 'CLAUDE', { localRefs: 2 }),
  row('codex-memory', 'AGENTS', { state: 'skipped', outcome: undefined, skipReason: 'turned-off' }),
  row('claude-skill', 'deploy-preview'),
  row('claude-agent', 'planner', {
    state: 'skipped',
    outcome: undefined,
    skipReason: 'host-outdated'
  })
]
export const newKinds = defineFixture({
  width: 784,
  render: () =>
    page(
      ON,
      ONE,
      { ...STATUS, rows: KIND_ROWS },
      true,
      'all',
      new Set(['user:codex-memory:AGENTS'])
    )
})

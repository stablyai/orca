import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type {
  OrcaUninstallEntryState,
  OrcaUninstallHostEntry,
  OrcaUninstallInstallKind,
  OrcaUninstallPath,
  OrcaUninstallPlan
} from '../../../../../../shared/uninstall/orca-uninstall-types'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { OrcaUninstallPanel } from './OrcaUninstallSection'
import type { OrcaUninstallModel, OrcaUninstallPhase } from './use-orca-uninstall'

const CODEX_ACCOUNT_HOOKS: OrcaUninstallPath = {
  path: '~/Library/Application Support/orca/codex-accounts/3f2a9c1e-5b7d-4e8a-9c61-2d4f8b0e7a15/home/hooks.json',
  orcaData: { kind: 'codex-account', relative: 'hooks.json' }
}

const AGENTS: [string, string[]][] = [
  ['claude', ['~/.claude/settings.json']],
  ['codex', []],
  ['gemini', ['~/.gemini/settings.json']],
  ['antigravity', ['~/.gemini/config/hooks.json']],
  ['cursor', ['~/.cursor/hooks.json']],
  ['copilot', ['~/.copilot/hooks/orca.json']],
  ['grok', ['~/.grok/hooks/orca-status.json']],
  ['opencode', ['~/.config/opencode/plugins/orca-opencode-status.js']],
  [
    'pi',
    [
      '~/.pi/agent/extensions/orca-status.ts',
      '~/.pi/agent/extensions/orca-titles.ts',
      '~/.pi/agent/extensions/orca-hooks.ts'
    ]
  ],
  ['hermes', ['~/.hermes/plugins/orca-status/']],
  ['kimi', ['~/.kimi-code/config.toml']],
  ['qwen-code', ['~/.qwen/settings.json']]
]

type HostKind = 'connected' | 'offline'

function makeHost(kind: HostKind, state: OrcaUninstallEntryState): OrcaUninstallHostEntry {
  const connected = kind === 'connected'
  return {
    hostId: connected ? 'openclaw' : 'gpu-box',
    label: connected ? 'openclaw' : 'gpu-box',
    connected,
    state,
    detail: connected || state === 'removed' ? null : 'Not connected.',
    manualCommand: connected ? null : 'orca uninstall'
  }
}

function makePlan(
  state: (part: string) => OrcaUninstallEntryState,
  installKind: OrcaUninstallInstallKind = 'mac-app',
  otherOrcaBuildName: string | null = 'Orca RC',
  hosts: readonly HostKind[] = ['connected']
): OrcaUninstallPlan {
  return {
    installKind,
    agents: AGENTS.map(([agent, paths]) => ({
      agent,
      paths:
        agent === 'codex' ? [CODEX_ACCOUNT_HOOKS] : paths.map((path) => ({ path, orcaData: null })),
      state: state(`agent:${agent}`),
      detail: state(`agent:${agent}`) === 'error' ? 'Permission denied' : null
    })),
    cliCommand: {
      commandName: 'orca',
      location: '/usr/local/bin/orca',
      state: state('cli'),
      detail: null
    },
    backgroundService: {
      location: 'launchd · com.stablyai.orca.serve',
      state: state('service'),
      detail: null
    },
    hookScripts: {
      location: '~/.orca/agent-hooks',
      state: state('scripts'),
      detail: state('scripts') === 'kept-shared' ? 'Still used by codex.' : null
    },
    hosts: hosts.map((kind) => makeHost(kind, state(`host:${kind}`))),
    terminalDaemon: {
      location: '~/Library/Application Support/orca/daemon',
      state: state('daemon'),
      detail: state('daemon') === 'error' ? 'Timed out waiting for daemon self-shutdown' : null
    },
    otherOrcaBuildName,
    appPath: '/Applications/Orca.app',
    removeAppCommand: installKind === 'mac-homebrew' ? 'brew uninstall --cask orca' : null
  }
}

const noop = (): void => {}

function model(
  plan: OrcaUninstallPlan,
  phase: OrcaUninstallPhase,
  runningStep: OrcaUninstallModel['runningStep'] = null
): OrcaUninstallModel {
  return {
    plan,
    loadFailed: false,
    phase,
    runningStep,
    retrying: new Set(),
    start: noop,
    retry: noop,
    reload: noop,
    finish: noop
  }
}

function Frame({ value }: { value: OrcaUninstallModel }): React.JSX.Element {
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <div>
        <SettingsGroup title="Uninstall">
          <OrcaUninstallPanel model={value} />
        </SettingsGroup>
      </div>
    </div>
  )
}

// Opens the section, then the hooks row, so the agent and host sub-rows are in the shot.
const expand = async (frame: HTMLElement): Promise<void> => {
  frame.querySelector<HTMLButtonElement>('[data-settings-group-disclosure] > button')?.click()
  await new Promise((resolve) => setTimeout(resolve, 50))
  frame.querySelector<HTMLButtonElement>('.divide-y button[aria-expanded="false"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const present = makePlan(() => 'present')
const removed = makePlan(() => 'removed')

export const collapsed = defineFixture({
  width: 760,
  render: () => <Frame value={model(present, 'idle')} />
})

export const expanded = defineFixture({
  width: 760,
  render: () => <Frame value={model(present, 'idle')} />,
  interact: expand
})

export const expandedHostNotConnected = defineFixture({
  width: 760,
  render: () => (
    <Frame
      value={model(
        makePlan(() => 'present', 'mac-app', 'Orca RC', ['offline']),
        'idle'
      )}
    />
  ),
  interact: expand
})

const done = new Set(['cli', 'service'])
export const running = defineFixture({
  width: 760,
  render: () => (
    <Frame
      value={model(
        makePlan((part) => (part.startsWith('agent:') || done.has(part) ? 'removed' : 'present')),
        'running',
        'hook-scripts'
      )}
    />
  ),
  interact: expand
})

export const doneMacApp = defineFixture({
  width: 760,
  render: () => <Frame value={model(removed, 'done')} />,
  interact: expand
})

export const doneHomebrew = defineFixture({
  width: 760,
  render: () => (
    <Frame
      value={model(
        makePlan(() => 'removed', 'mac-homebrew'),
        'done'
      )}
    />
  ),
  interact: expand
})

export const partialFailure = defineFixture({
  width: 760,
  render: () => (
    <Frame
      value={model(
        makePlan(
          (part) => {
            if (part === 'agent:codex' || part === 'daemon') {
              return 'error'
            }
            if (part === 'host:offline') {
              return 'needs-user'
            }
            // Codex still runs the scripts, so the run kept them.
            if (part === 'scripts') {
              return 'kept-shared'
            }
            return 'removed'
          },
          'mac-app',
          null,
          ['connected', 'offline']
        ),
        'done'
      )}
    />
  ),
  interact: expand
})

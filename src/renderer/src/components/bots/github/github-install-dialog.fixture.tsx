import { defineFixture } from '../../../component-fixtures/component-fixture'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { stopAwaitingGitHub } from '@/lib/bot-github-state'
import { cancelConnectorConnect } from '@/lib/connector-connect-state'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeRepo } from '../../worktree-jump/worktree-jump-palette-test-fixtures'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'
import {
  openGitHubInstall,
  resetGitHubInstallForTests,
  useGitHubInstallRecord
} from '@/lib/bot-github-install-record'
import { BotGitHubSetupDialog } from './BotGitHubSetupDialog'
import { GitHubInstallPill } from './GitHubInstallPill'

const marketing: Bot = {
  id: 'bot-marketing',
  name: 'Marketing - X - Manager',
  hostId: 'local',
  folder: 'marketing',
  folderWorkspaceId: 'fw-marketing',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const stablyai: ConnectorGitHubInstallation = {
  installationId: '1',
  accountLogin: 'stablyai',
  repositories: [
    { fullName: 'stablyai/orca' },
    { fullName: 'stablyai/website' },
    { fullName: 'acme/widgets' }
  ]
}
// What GitHub's install page saved: a repository on the first install, and a new organization.
const afterGitHub: ConnectorGitHubInstallation[] = [
  {
    ...stablyai,
    repositories: [...(stablyai.repositories ?? []), { fullName: 'stablyai/handbook' }]
  },
  {
    installationId: '2',
    accountLogin: 'carol-labs',
    repositories: [{ fullName: 'carol-labs/press-kit' }]
  }
]

let installations: ConnectorGitHubInstallation[] = [stablyai]
const neverReturns = (): Promise<never> => new Promise(() => {})

function stubGitHub(): void {
  installations = [stablyai]
  stopAwaitingGitHub('local')
  cancelConnectorConnect('local', 'github')
  resetGitHubInstallForTests()
  publishBots([marketing])
  openGitHubInstall(marketing)
  Reflect.set(window.api, 'botGitHub', {
    state: async () => ({
      ok: true,
      value: {
        installUrl: 'https://github.com/apps/orca-ide/installations/new',
        account: { userId: '42', login: 'carol-gh' },
        installations,
        defaultBotId: null
      }
    }),
    users: async () => ({ ok: false, error: 'fixture' }),
    connect: neverReturns,
    cancelConnect: async () => undefined,
    unlink: neverReturns
  })
  Reflect.set(window.api, 'shell', { ...window.api.shell, openUrl: async () => undefined })
  withBotConnectorRuntime(window.api)
}

const WORKSPACE = makeWorktree({ id: 'repo-1::/marketing', repoId: 'repo-1', path: '/marketing' })
// Link setting = open in Orca, in the bot's workspace.
const inOrcaStore = {
  settings: { ...getDefaultSettings('/home/fixture'), openLinksInApp: true },
  activeWorktreeId: WORKSPACE.id,
  repos: [makeRepo()],
  worktreesByRepo: { 'repo-1': [WORKSPACE] }
}

/** The setup as the app mounts it: the dialog, or minimized to the pill. */
function Setup(): React.JSX.Element | null {
  const record = useGitHubInstallRecord()
  if (!record) {
    return null
  }
  return (
    <ConfirmationDialogProvider>
      <BotGitHubSetupDialog bot={marketing} record={record} />
      {record.surface === 'pill' ? <GitHubInstallPill record={record} /> : null}
    </ConfirmationDialogProvider>
  )
}

/** Stand-ins for the bot's chat and Orca's browser pane beside it, under the pill. */
function Scene({ chatWidth = 300 }: { chatWidth?: number }): React.JSX.Element {
  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <div style={{ width: chatWidth }} className="flex shrink-0 flex-col border-r border-border">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            Marketing - X - Manager
          </div>
          <p className="p-4 text-sm">
            Hi, I&apos;m Marketing - X - Manager. What would you like me to work on first?
          </p>
          {/* The real composer's footprint: its box, the workspace footer row, then pb-4. */}
          <div className="mt-auto px-3 pt-2 pb-4">
            <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
              Ask anything, @ to mention…
              <div className="mt-2 flex items-center justify-between">
                <span className="grid size-6 place-items-center rounded-md border border-border">
                  +
                </span>
                <span className="grid size-6 place-items-center rounded-full bg-muted">↑</span>
              </div>
            </div>
            <div className="mt-1 flex h-5.5 items-center px-3 text-2xs text-muted-foreground">
              main · Folder
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-border px-3 py-2.5 text-xs text-muted-foreground">
            github.com/organizations/stablyai/settings/installations
          </div>
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
            GitHub&apos;s install page (Orca browser pane)
          </div>
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center border-t border-border bg-sidebar px-3 text-2xs text-muted-foreground">
        Status bar
      </div>
      <Setup />
    </div>
  )
}

async function clickWhenShown(name: string): Promise<void> {
  for (let tries = 0; tries < 80; tries++) {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name
    )
    if (button) {
      button.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const before = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: stubGitHub,
  render: () => <Scene />
})

// GitHub's page opened in Orca's browser: setup minimized to the pill by itself.
export const inOrcaMinimized = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: stubGitHub,
  render: () => <Scene />,
  interact: () => clickWhenShown('Add repositories or an organization')
})

// GitHub reported the save: the pill says what was added, before it expands.
export const inOrcaDone = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: stubGitHub,
  render: () => <Scene />,
  interact: async () => {
    await clickWhenShown('Add repositories or an organization')
    installations = afterGitHub
    // The next poll (every 3 s) sees the change.
    await settle(3300)
  }
})

// Then the dialog opens again on the new repositories.
export const inOrcaExpanded = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: stubGitHub,
  render: () => <Scene />,
  interact: async () => {
    await clickWhenShown('Add repositories or an organization')
    installations = afterGitHub
    await settle(5200)
  }
})

export const systemBrowserWaiting = defineFixture({
  width: 1100,
  setup: stubGitHub,
  render: () => <Scene />,
  interact: () => clickWhenShown('Add repositories or an organization')
})

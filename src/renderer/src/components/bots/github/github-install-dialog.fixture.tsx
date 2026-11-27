import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'
import {
  Setup,
  clickAddRepositories,
  inOrcaStore,
  marketing,
  settle,
  setGitHubInstallations,
  stablyai,
  stubGitHub
} from './github-setup-dialog.test-fixture'

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

const triage: Bot = {
  ...marketing,
  id: 'bot-triage',
  name: 'GitHub issue triage',
  folder: 'github-issue-triage'
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

export const before = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: () => stubGitHub(),
  render: () => <Scene />
})

export const connect = defineFixture({
  width: 1100,
  setup: () => stubGitHub({ bot: triage, signedIn: false }),
  render: () => <Scene />
})

// Already on GitHub: how to ask, and the repositories on one line.
export const done = defineFixture({
  width: 1100,
  setup: () =>
    stubGitHub({
      bot: { ...triage, github: {} },
      with: [
        {
          installationId: '1',
          accountLogin: 'stablyai',
          repositories: ['orca', 'website', 'handbook', 'api', 'plugins', 'devex', 'widgets'].map(
            (name) => ({ fullName: `stablyai/${name}` })
          )
        }
      ]
    }),
  render: () => <Scene />
})

// GitHub's page opened in Orca's browser: setup minimized to the pill by itself.
export const inOrcaMinimized = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: () => stubGitHub(),
  render: () => <Scene />,
  interact: () => clickAddRepositories()
})

// GitHub reported the save: the pill says what was added, before it expands.
export const inOrcaDone = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: () => stubGitHub(),
  render: () => <Scene />,
  interact: async () => {
    await clickAddRepositories()
    setGitHubInstallations(afterGitHub)
    // The next poll (every 3 s) sees the change.
    await settle(3300)
  }
})

// Then the dialog opens again on the new repositories.
export const inOrcaExpanded = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: () => stubGitHub(),
  render: () => <Scene />,
  interact: async () => {
    await clickAddRepositories()
    setGitHubInstallations(afterGitHub)
    await settle(5200)
  }
})

export const systemBrowserWaiting = defineFixture({
  width: 1100,
  setup: () => stubGitHub(),
  render: () => <Scene />,
  interact: () => clickAddRepositories()
})

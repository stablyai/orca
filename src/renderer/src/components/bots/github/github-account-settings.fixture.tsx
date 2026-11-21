import { defineFixture } from '../../../component-fixtures/component-fixture'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { refreshBotGitHub } from '@/lib/bot-github-state'
import type { ConnectorGitHubState } from '../../../../../shared/connector-bot-github-contract'
import { GitHubAccountSettings } from './GitHubAccountSettings'

const neverReturns = (): Promise<never> => new Promise(() => {})

function stubGitHub(linkedAccounts: ConnectorGitHubState['linkedAccounts']): void {
  publishBots([])
  Reflect.set(window.api, 'botGitHub', {
    state: async () => ({
      ok: true,
      value: {
        installUrl: 'https://github.com/apps/orca-ide/installations/new',
        account: { userId: '42', login: 'carol-gh' },
        installations: [{ installationId: '1', accountLogin: 'stablyai', repositories: null }],
        defaultBotId: null,
        linkedAccounts
      } satisfies ConnectorGitHubState
    }),
    users: async () => ({ ok: false, error: 'fixture' }),
    connect: neverReturns,
    cancelConnect: async () => undefined,
    unlink: neverReturns,
    setDefaultBot: neverReturns
  })
  withBotConnectorRuntime(window.api)
  void refreshBotGitHub('local')
}

/** An Orca account's GitHub section, as the settings page lays it out. */
function Section(): React.JSX.Element {
  return (
    <div className="bg-background p-6">
      <GitHubAccountSettings hostId="local" hostName={null} />
    </div>
  )
}

/** The same GitHub login linked from this computer's Orca account and another computer's. */
export const twoAccounts = defineFixture({
  width: 720,
  setup: () =>
    stubGitHub([
      { current: true, machines: ['Carol’s MacBook Pro'], linkedAt: 2 },
      { current: false, machines: ['studio-mac', 'build-box'], linkedAt: 1 }
    ]),
  render: () => <Section />
})

/** Linked from this account alone: as before, with no list. */
export const oneAccount = defineFixture({
  width: 720,
  setup: () => stubGitHub([{ current: true, machines: ['Carol’s MacBook Pro'], linkedAt: 1 }]),
  render: () => <Section />
})

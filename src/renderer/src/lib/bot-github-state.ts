// Each host account's GitHub link and installs as Orca Cloud reports them, read on demand and shared
// by every GitHub surface for that host (createConnectorHostState).
import {
  BOT_GITHUB_OFF,
  type ConnectorGitHubState
} from '../../../shared/connector-bot-github-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../shared/connector-bot-slack-contract'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { botGitHubCalls } from './bot-connector-host-calls'
import { connectorReturnUrl } from './browser-return-watch'
import {
  type AwaitConnectorOptions,
  type ConnectorAwait,
  type ConnectorWait,
  createConnectorHostState
} from './connector-host-state'

/** `off`: the cloud has no GitHub yet, so every GitHub surface reads "Coming soon". */
export type BotGitHubView =
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'ready'; github: ConnectorGitHubState }
  | { status: 'failed'; error: string }

export type GitHubAwait = ConnectorAwait
export type GitHubWait = ConnectorWait
export type AwaitGitHubOptions = AwaitConnectorOptions

async function askGitHub(hostId: ExecutionHostId): Promise<BotGitHubView> {
  try {
    const result = await botGitHubCalls(hostId).state()
    return result.ok
      ? { status: 'ready', github: result.value }
      : result.error === BOT_GITHUB_OFF
        ? { status: 'off' }
        : { status: 'failed', error: result.error }
  } catch {
    return { status: 'failed', error: BOT_SLACK_DESKTOP_ERRORS.failed }
  }
}

/** What a confirmed link or an install changes. */
function linkShape(current: BotGitHubView): string | null {
  if (current.status !== 'ready') {
    return null
  }
  const { account, installations } = current.github
  return JSON.stringify([
    account?.userId ?? null,
    // Repositories too: adding some to an existing install keeps its id.
    installations.map((installation) => [
      installation.installationId,
      installation.repositories?.map((repository) => repository.fullName).sort() ?? null
    ])
  ])
}

const github = createConnectorHostState<BotGitHubView>({
  loading: { status: 'loading' },
  ask: askGitHub,
  shape: linkShape,
  returnUrl: (view) =>
    view.status === 'ready' ? connectorReturnUrl('github', view.github.installUrl) : null
})

export const readBotGitHub = github.read
export const refreshBotGitHub = github.refresh
/** Every change to any host's read state or wait. */
export const subscribeBotGitHub = github.subscribe
export const readGitHubAwait = github.readAwait
export const isGitHubWaitRunning = github.isWaitRunning
export const stopAwaitingGitHub = github.stopAwaiting
export const awaitGitHubChange = github.awaitChange
export const useBotGitHubRead = github.useRead
export const useBotGitHub = github.useView
export const useGitHubAwait = github.useAwait

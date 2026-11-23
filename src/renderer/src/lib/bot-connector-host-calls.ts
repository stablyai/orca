// A host's Slack, Linear and GitHub setup (`bots.slack/linear/github/connect.*`), run on that host as
// its own Orca account: this app's runtime for its own bots, a paired server's for the server's.
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult,
  type ConnectorBotSlackAppResponse,
  type ConnectorBotSlackHandOffResponse,
  type ConnectorBotSlackMembersResponse,
  type ConnectorBotSlackPostAsResponse,
  type ConnectorBotSlackStateResponse,
  type SlackPostAs
} from '../../../shared/connector-bot-slack-contract'
import type {
  ConnectorLinearMembersResponse,
  ConnectorLinearState
} from '../../../shared/connector-bot-linear-contract'
import type {
  ConnectorGitHubState,
  ConnectorGitHubUsersResponse
} from '../../../shared/connector-bot-github-contract'
import type { ConnectorConnectSource } from '../../../shared/connectors/connector-cloud-contract'
import type { ConnectorConnectRedeem } from '../../../../cloud/packages/connector-contract/src/connect-messages'
import { botHostTarget } from './bot-hosts'

/** A trip's end: the linked account, or null when it ends at "Open Orca" and its deep link redeems. */
export type ConnectorTripResult = BotSlackResult<ConnectorConnectRedeem | null>
export type ConnectorTripWait =
  | { state: 'waiting' }
  | { state: 'done'; result: ConnectorTripResult }

// A wait slice is 45 s on the host; the call allows for the trip there and back.
const TRIP_WAIT_TIMEOUT_MS = 60_000

/** An unreachable host, or one too old to have the method, reads as the cloud's plain failure. */
function call<T>(
  hostId: ExecutionHostId,
  method: string,
  params?: unknown
): Promise<BotSlackResult<T>> {
  return callRuntimeRpc<BotSlackResult<T>>(botHostTarget(hostId), method, params).catch(() => ({
    ok: false,
    error: BOT_SLACK_DESKTOP_ERRORS.failed
  }))
}

export function botSlackCalls(hostId: ExecutionHostId) {
  return {
    /** The token is handed to the host's cloud and nowhere else. */
    saveGrant: (args: { refreshToken: string }) =>
      call<{ teamId: string }>(hostId, 'bots.slack.saveGrant', args),
    forgetGrant: (args: { teamId: string }) =>
      call<undefined>(hostId, 'bots.slack.forgetGrant', args),
    /** Without a team, the bot's first workspace; `teams` lists every one, from a newer cloud. */
    state: (args: { botId: string; teamId?: string }) =>
      call<ConnectorBotSlackStateResponse>(hostId, 'bots.slack.state', args),
    setUpApp: (args: { botId: string; teamId: string }) =>
      call<ConnectorBotSlackAppResponse>(hostId, 'bots.slack.setUpApp', args),
    /** A one-time code this desktop's own Orca account redeems to create the bot's app. */
    handOff: (args: { botId: string; teamId: string }) =>
      call<ConnectorBotSlackHandOffResponse>(hostId, 'bots.slack.handOff', args),
    /** After a hand-off: the host records the app as its cloud reads it. */
    adoptApp: (args: { botId: string; teamId: string }) =>
      call<undefined>(hostId, 'bots.slack.adoptApp', args),
    /** Without a team, every workspace. */
    remove: (args: { botId: string; teamId?: string }) =>
      call<undefined>(hostId, 'bots.slack.remove', args),
    members: (args: { botId: string; query: string; teamId?: string }) =>
      call<ConnectorBotSlackMembersResponse>(hostId, 'bots.slack.members', args),
    setPostAs: (
      args:
        | { botId: string; teamId: string; postAs: SlackPostAs; setupState?: string }
        | { botId: string; teamId: string; cancel: true }
    ) => call<ConnectorBotSlackPostAsResponse | undefined>(hostId, 'bots.slack.setPostAs', args),
    /** Whether this workspace's new replies end with the "Open this thread in Orca" link. */
    setThreadLink: (args: { botId: string; teamId: string; threadLink: boolean }) =>
      call<undefined>(hostId, 'bots.slack.setThreadLink', args)
  }
}

export function botLinearCalls(hostId: ExecutionHostId) {
  return {
    state: () => call<ConnectorLinearState>(hostId, 'bots.linear.state'),
    unlink: (args: { workspaceId: string }) => call<undefined>(hostId, 'bots.linear.unlink', args),
    members: (args: { workspaceId: string; query: string }) =>
      call<ConnectorLinearMembersResponse>(hostId, 'bots.linear.members', args),
    setDefaultBot: (args: { workspaceId: string; botId: string | null }) =>
      call<undefined>(hostId, 'bots.linear.setDefaultBot', args)
  }
}

export function botGitHubCalls(hostId: ExecutionHostId) {
  return {
    state: () => call<ConnectorGitHubState>(hostId, 'bots.github.state'),
    users: (args: { query: string }) =>
      call<ConnectorGitHubUsersResponse>(hostId, 'bots.github.users', args),
    /** `userId`: one linked GitHub user; none unlinks them all, as an older host does. */
    unlink: (args: { userId?: string } = {}) => call<undefined>(hostId, 'bots.github.unlink', args),
    setDefaultBot: (args: { botId: string | null; userId?: string }) =>
      call<undefined>(hostId, 'bots.github.setDefaultBot', args)
  }
}

export function connectorTripCalls(hostId: ExecutionHostId, source: ConnectorConnectSource) {
  return {
    /** The page to open once the host listens for its return; `addAccess` comes back from a host
     *  that has it. */
    start: (switchAccount: boolean, addAccess?: { workspace?: string }) =>
      call<{ tripId: string; authorizeUrl: string; addAccess?: true }>(
        hostId,
        'bots.connect.start',
        { source, switchAccount, ...(addAccess ? { addAccess } : {}) }
      ),
    /** One slice of waiting for the trip's end. */
    wait: (tripId: string): Promise<ConnectorTripWait> =>
      callRuntimeRpc<ConnectorTripWait>(
        botHostTarget(hostId),
        'bots.connect.wait',
        { tripId },
        { timeoutMs: TRIP_WAIT_TIMEOUT_MS }
      ),
    cancel: () =>
      callRuntimeRpc(botHostTarget(hostId), 'bots.connect.cancel', { source }).catch(() => {}),
    redeem: (result: string) =>
      call<ConnectorConnectRedeem>(hostId, 'bots.connect.redeem', { source, result })
  }
}

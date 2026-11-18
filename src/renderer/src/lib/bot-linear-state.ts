// Each host account's Linear links as Orca Cloud reports them, read on demand and shared by every
// Linear surface for that host (createConnectorHostState).
import {
  BOT_LINEAR_OFF,
  type ConnectorLinearState
} from '../../../shared/connector-bot-linear-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../shared/connector-bot-slack-contract'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { botLinearCalls } from './bot-connector-host-calls'
import { connectorReturnUrl } from './browser-return-watch'
import { createConnectorHostState } from './connector-host-state'

/** `off`: the cloud has no Linear yet, so every Linear surface reads "Coming soon". */
export type BotLinearView =
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'ready'; linear: ConnectorLinearState }
  | { status: 'failed'; error: string }

async function askLinear(hostId: ExecutionHostId): Promise<BotLinearView> {
  try {
    const result = await botLinearCalls(hostId).state()
    return result.ok
      ? { status: 'ready', linear: result.value }
      : result.error === BOT_LINEAR_OFF
        ? { status: 'off' }
        : { status: 'failed', error: result.error }
  } catch {
    return { status: 'failed', error: BOT_SLACK_DESKTOP_ERRORS.failed }
  }
}

/** Which workspaces are linked, as whom, and installed: what a link or an install changes. */
function linkShape(current: BotLinearView): string | null {
  return current.status === 'ready'
    ? JSON.stringify(
        current.linear.workspaces.map(({ workspaceId, userId, installed }) => [
          workspaceId,
          userId,
          installed
        ])
      )
    : null
}

const linear = createConnectorHostState<BotLinearView>({
  loading: { status: 'loading' },
  ask: askLinear,
  shape: linkShape,
  returnUrl: (view) =>
    view.status === 'ready' ? connectorReturnUrl('linear', view.linear.installUrl) : null
})

export const readBotLinear = linear.read
export const refreshBotLinear = linear.refresh
/** Follows the host's Linear until its links or installs change, e.g. while an admin installs. */
export const awaitLinearChange = linear.awaitChange
export const useBotLinearRead = linear.useRead
export const useBotLinear = linear.useView
export const useLinearAwait = linear.useAwait
export const readLinearAwait = linear.readAwait

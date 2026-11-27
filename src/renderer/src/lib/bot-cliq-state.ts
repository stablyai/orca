// Each host account's Zoho Cliq sign-ins as Orca Cloud reports them, read on demand and shared by every
// Cliq surface for that host (createConnectorHostState).
import { BOT_CLIQ_OFF, type ConnectorCliqState } from '../../../shared/connector-bot-cliq-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../shared/connector-bot-slack-contract'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { botCliqCalls } from './bot-connector-host-calls'
import { createConnectorHostState } from './connector-host-state'

/** `off`: the cloud has no Cliq yet, so every Cliq surface reads "Coming soon". */
export type BotCliqView =
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'ready'; cliq: ConnectorCliqState }
  | { status: 'failed'; error: string }

async function askCliq(hostId: ExecutionHostId): Promise<BotCliqView> {
  try {
    const result = await botCliqCalls(hostId).orgs()
    return result.ok
      ? { status: 'ready', cliq: result.value }
      : result.error === BOT_CLIQ_OFF
        ? { status: 'off' }
        : { status: 'failed', error: result.error }
  } catch {
    return { status: 'failed', error: BOT_SLACK_DESKTOP_ERRORS.failed }
  }
}

const cliq = createConnectorHostState<BotCliqView>({
  loading: { status: 'loading' },
  ask: askCliq,
  // Which organizations are signed in, as whom, and whether Zoho still takes the sign-in.
  shape: (view) =>
    view.status === 'ready'
      ? JSON.stringify(view.cliq.orgs.map(({ orgId, userId, expired }) => [orgId, userId, expired]))
      : null,
  // Zoho's page never sends the browser back to a page Orca watches; the connect trip's loopback does.
  returnUrl: () => null
})

export const readBotCliq = cliq.read
export const refreshBotCliq = cliq.refresh
export const useBotCliq = cliq.useView

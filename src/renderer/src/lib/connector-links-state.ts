// Each host account's linked Slack, GitHub and Linear people as Orca Cloud reports them, read on
// demand and shared by every surface for that host (createConnectorHostState).
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../shared/connector-bot-slack-contract'
import {
  CONNECTOR_LINKS_OFF,
  type ConnectorLink
} from '../../../shared/connectors/connector-links-contract'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { connectorLinksCalls } from './bot-connector-host-calls'
import { createConnectorHostState } from './connector-host-state'

/** `off`: a cloud from before linked accounts, so there is nothing to show. */
export type ConnectorLinksView =
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'ready'; links: readonly ConnectorLink[] }
  | { status: 'failed'; error: string }

async function askLinks(hostId: ExecutionHostId): Promise<ConnectorLinksView> {
  try {
    const result = await connectorLinksCalls(hostId).list()
    return result.ok
      ? { status: 'ready', links: result.value.links }
      : result.error === CONNECTOR_LINKS_OFF
        ? { status: 'off' }
        : { status: 'failed', error: result.error }
  } catch {
    return { status: 'failed', error: BOT_SLACK_DESKTOP_ERRORS.failed }
  }
}

const links = createConnectorHostState<ConnectorLinksView>({
  loading: { status: 'loading' },
  ask: askLinks,
  shape: (view) =>
    view.status === 'ready'
      ? JSON.stringify(
          view.links.map(({ source, workspaceId, userId }) => [source, workspaceId, userId])
        )
      : null,
  // Linking runs as a connect trip, which refreshes this when it ends.
  returnUrl: () => null
})

export const refreshConnectorLinks = links.refresh
export const useConnectorLinks = links.useView

import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { automationAuthorityCatalogKey } from '../hosts/automation-host-catalog-types'
import type { AutomationListRow } from './automation-list-row-identity'

/** Where the list finds a bot's automations: the catalog authority of the host that runs it. */
export type AutomationListBotHost = {
  authorityKey: string
  /** Rows listed before the catalog answers come from this computer, so only its bots claim them. */
  claimsUncataloguedRows: boolean
}

/**
 * The bot's host as the catalog lists it. A bot on this computer is listed under the desktop, or under
 * the server this client reaches it through (a paired web client); a paired server's bot, under that server.
 */
export function automationListBotHost(
  hostId: string,
  desktopAliasEnvironmentId: string | null
): AutomationListBotHost {
  const parsed = parseExecutionHostId(hostId)
  const environmentId =
    parsed?.kind === 'runtime' ? parsed.environmentId : (desktopAliasEnvironmentId ?? null)
  return {
    authorityKey: automationAuthorityCatalogKey(
      environmentId ? { kind: 'runtime', environmentId } : { kind: 'desktop' }
    ),
    // The pre-catalog list is read over this client's own transport, which the alias names.
    claimsUncataloguedRows:
      parsed?.kind !== 'runtime' || environmentId === (desktopAliasEnvironmentId ?? null)
  }
}

export function rowOnBotHost(row: AutomationListRow, host: AutomationListBotHost): boolean {
  return row.catalogRef
    ? automationAuthorityCatalogKey(row.catalogRef.authority) === host.authorityKey
    : host.claimsUncataloguedRows
}

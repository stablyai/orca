/**
 * Pacing for the ticket panel's unattended refresh.
 *
 * Odoo has no push channel, so the panel re-reads on a timer. Four hours is
 * deliberately slow: the manual Refresh button covers "I want it now", and on
 * SSH every read shares the relay with the rest of Orca, so an eager poll would
 * cost more than the staleness it removes.
 */
export const ODOO_TICKET_PANEL_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

export function shouldRunScheduledOdooRefresh(args: {
  connected: boolean
  windowVisible: boolean
  /** A read is already in flight; a second one would only queue behind it. */
  loading: boolean
}): boolean {
  return args.connected && args.windowVisible && !args.loading
}

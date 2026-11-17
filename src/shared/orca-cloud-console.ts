// The Orca Cloud web console: where team, billing and Enterprise settings are managed. The desktop
// only links to it (Settings rows, account menu, "Fix in browser" buttons); main opens the page in
// the system browser through a single-use ticket URL from auth.

import { ORCA_BILLING_INTERVALS, type OrcaBillingInterval } from './orca-billing'

/** Console pages the desktop can ask auth for (the ticket's `page`). */
const ORCA_CLOUD_CONSOLE_SECTIONS = [
  'home',
  'team',
  'billing',
  'enterprise',
  'audit-log',
  'api',
  'routines'
] as const
export type OrcaCloudConsoleSection = (typeof ORCA_CLOUD_CONSOLE_SECTIONS)[number]

/**
 * The plan and billing period picked in the desktop's plans dialog, for the console's billing page
 * to preselect (a hint: the page never buys on its own). Sent only to an auth that advertises
 * ORCA_CLOUD_CONSOLE_BILLING_HINT_CAPABILITY, so an older one never sees fields it would refuse.
 */
export type OrcaCloudConsoleBillingHint = { plan: string; interval: OrcaBillingInterval }

/** Desktop capability flag auth sets once its console ticket accepts `plan` and `interval`. */
export const ORCA_CLOUD_CONSOLE_BILLING_HINT_CAPABILITY = 'console.billing_hint'

/**
 * Desktop capability flag auth sets once its console ticket accepts the API pages (`api`,
 * `routines`). An older auth would refuse them, so they go out as `home` until it advertises this.
 */
const ORCA_CLOUD_CONSOLE_CLOUD_API_CAPABILITY = 'console.cloud_api'

const CLOUD_API_CONSOLE_SECTIONS: readonly OrcaCloudConsoleSection[] = ['api', 'routines']

/**
 * The page the ticket asks for: an API page only when auth advertises it and there is an active
 * team (auth refuses `api`/`routines` without an orgId); otherwise the console home.
 */
export function cloudConsoleTicketPage(
  section: OrcaCloudConsoleSection,
  flags: Record<string, boolean> | undefined,
  orgId: string | null
): OrcaCloudConsoleSection {
  return CLOUD_API_CONSOLE_SECTIONS.includes(section) &&
    (flags?.[ORCA_CLOUD_CONSOLE_CLOUD_API_CAPABILITY] !== true || !orgId)
    ? 'home'
    : section
}

export type OrcaCloudConsoleOpenArgs = {
  section: OrcaCloudConsoleSection
  /** Billing page only; ignored for every other section. */
  billingHint?: OrcaCloudConsoleBillingHint
}

const PLAN_ID = /^[a-z][a-z0-9_]{0,39}$/

/** The hint as main accepts it from the renderer, or null for anything else. */
export function parseOrcaCloudConsoleBillingHint(
  value: unknown
): OrcaCloudConsoleBillingHint | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const plan = 'plan' in value ? value.plan : undefined
  const interval = 'interval' in value ? value.interval : undefined
  if (typeof plan !== 'string' || !PLAN_ID.test(plan)) {
    return null
  }
  const known = ORCA_BILLING_INTERVALS.find((entry) => entry === interval)
  return known ? { plan, interval: known } : null
}

export type OrcaCloudConsoleOpenResult =
  /**
   * `signedIn: false`: no ticket, so the browser asks the person to sign in. `ticketError`: a
   * signed-in desktop's ticket couldn't be minted (`failed`) or pointed somewhere not allowed
   * (`rejected`), so the person should hear why the console asks them to sign in.
   */
  | { status: 'opened'; signedIn: boolean; ticketError?: 'failed' | 'rejected' }
  /** This build has no Orca Cloud, so there is no console to open. */
  | { status: 'unconfigured' }
  | { status: 'failed'; error: string }

export function isOrcaCloudConsoleSection(value: unknown): value is OrcaCloudConsoleSection {
  return ORCA_CLOUD_CONSOLE_SECTIONS.some((section) => section === value)
}

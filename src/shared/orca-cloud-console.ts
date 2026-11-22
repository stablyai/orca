// The Orca web console, where team and admin settings are managed. The desktop only links to it;
// main opens the page in the system browser through a single-use ticket URL from auth.
import type { OrcaProfileAuthStatus } from './orca-profiles/orca-profiles'

/** The capability auth sets for accounts that can use the web console. */
export const ORCA_CLOUD_CONSOLE_CAPABILITY = 'billing'

const ORCA_CLOUD_CONSOLE_SECTIONS = ['home'] as const
export type OrcaCloudConsoleSection = (typeof ORCA_CLOUD_CONSOLE_SECTIONS)[number]

export type OrcaCloudConsoleOpenArgs = { section: OrcaCloudConsoleSection }

export type OrcaCloudConsoleOpenResult =
  /** `ticketError`: a signed-in desktop's ticket failed or pointed off the allowed origins. */
  | { status: 'opened'; signedIn: boolean; ticketError?: 'failed' | 'rejected' }
  | { status: 'unconfigured' }
  | { status: 'failed'; error: string }

export function isOrcaCloudConsoleSection(value: unknown): value is OrcaCloudConsoleSection {
  return ORCA_CLOUD_CONSOLE_SECTIONS.some((section) => section === value)
}

/** UI only: the console re-checks access server side. */
export function isOrcaCloudConsoleAvailable(auth: OrcaProfileAuthStatus | null): boolean {
  return (
    auth?.state === 'connected' && auth.capabilities?.flags[ORCA_CLOUD_CONSOLE_CAPABILITY] === true
  )
}

// The Orca Cloud web console: where team, billing and Enterprise settings are managed. The desktop
// only links to it (Settings rows, account menu, "Fix in browser" buttons); main opens the page in
// the system browser, signed in with a single-use code when auth hands one out.

/** Console pages the desktop links to. Each is `<consoleOrigin>/console/<section>`. */
export const ORCA_CLOUD_CONSOLE_SECTIONS = ['team', 'billing', 'enterprise'] as const
export type OrcaCloudConsoleSection = (typeof ORCA_CLOUD_CONSOLE_SECTIONS)[number]

export type OrcaCloudConsoleOpenArgs = { section: OrcaCloudConsoleSection }

export type OrcaCloudConsoleOpenResult =
  /** `signedIn: false`: no code, so the browser asks the person to sign in. */
  | { status: 'opened'; signedIn: boolean }
  /** This build has no Orca Cloud, so there is no console to open. */
  | { status: 'unconfigured' }
  | { status: 'failed'; error: string }

export function isOrcaCloudConsoleSection(value: unknown): value is OrcaCloudConsoleSection {
  return ORCA_CLOUD_CONSOLE_SECTIONS.some((section) => section === value)
}

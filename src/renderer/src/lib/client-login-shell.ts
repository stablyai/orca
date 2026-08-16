/**
 * Login shell (`$SHELL`) of the machine running this client, or '' when
 * unknown (web build, preload unavailable).
 *
 * Why: commands Orca hands the user to paste — or types into a locally
 * spawned pane — are parsed by that shell, and fish does not share the sh
 * grammar for every construct.
 */
export function getClientLoginShell(): string {
  try {
    return window.api?.platform?.get?.().shell ?? ''
  } catch {
    return ''
  }
}

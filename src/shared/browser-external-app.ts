/** A page in the built-in browser wants to hand a link to another app (Okta Verify, Zoom, mail). */
export type BrowserExternalAppPrompt = {
  /** The OS handler's display name; null when unknown, e.g. on Linux. */
  appName: string | null
  /** Link scheme without the colon, e.g. `zoommtg`. */
  scheme: string
  /** Origin of the asking page; null for opaque or unparseable pages. */
  origin: string | null
}

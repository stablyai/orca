/** A page in the built-in browser wants to hand a link to another app (Okta Verify, Zoom, mail). */
export type BrowserExternalAppRequest = {
  requestId: string
  /** The OS handler's display name; null when unknown, e.g. on Linux. */
  appName: string | null
  /** Link scheme without the colon, e.g. `zoommtg`. */
  scheme: string
  /** Origin of the asking page; null for opaque or unparseable pages. */
  origin: string | null
}

export type BrowserExternalAppResponse = {
  requestId: string
  open: boolean
}

/** `launch-failed`: the user chose Open but the OS could not start an app, e.g. none is installed. */
export type BrowserExternalAppResponseResult = 'rejected' | 'answered' | 'launch-failed'

export type BrowserLinkOpeningSettings = {
  /** Links from Orca surfaces join the browser without taking focus from the pane they came from. */
  openLinksInAppInBackground?: boolean
  /** Installed browser for external opens; null or absent uses the OS default browser. */
  externalBrowserId?: string | null
}

export type BrowserLinkOpeningSettings = {
  /** Links from Orca surfaces join the browser without taking focus from the pane they came from. */
  openLinksInAppInBackground?: boolean
  /** Desktop plain-click mode for HTTP links in chat, terminals, the dashboard and sidebar; absent until the first load maps it. */
  httpLinkClickBehavior?: 'ask' | 'open'
}

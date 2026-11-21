export type BrowserLinkOpeningSettings = {
  /** Links from Orca surfaces join the browser without taking focus from the pane they came from. */
  openLinksInAppInBackground?: boolean
  /** Links navigate the most recent browser tab in their workspace instead of opening a new tab or split. */
  openLinksInExistingBrowserTab?: boolean
}

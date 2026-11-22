export type BrowserLinkOpeningSettings = {
  /** Links from Orca surfaces join the browser without taking focus from the pane they came from. */
  openLinksInAppInBackground?: boolean
  /** A link from a lone occupied pane splits beside it; off opens it as a tab in that pane. */
  openLinksInAppInSplit?: boolean
}

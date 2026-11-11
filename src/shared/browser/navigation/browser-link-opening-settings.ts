export type BrowserLinkOpeningSettings = {
  /** Links from Orca surfaces join the browser without taking focus from the pane they came from. */
  openLinksInAppInBackground?: boolean
  /** With no browser visible, a link splits beside its source pane; off opens it as a tab in that pane. */
  openLinksInAppInSplit?: boolean
}

export type BrowserLinkOpeningSettings = {
  /** Links from Orca surfaces join the browser without taking focus from the pane they came from. */
  openLinksInAppInBackground?: boolean
  /** When false, a link with no visible browser opens as a tab in the clicked pane instead of a split beside it. */
  openLinksInAppSplitBeside?: boolean
}

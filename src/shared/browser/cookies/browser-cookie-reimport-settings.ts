export type BrowserCookieReimportSettings = {
  /** Opt-in: re-import cookies from each profile's source browser on launch; Electron drops session cookies on quit. */
  browserCookieReimportOnLaunch?: boolean
}

export type BrowserBasicAuthRequest = {
  requestId: string
  browserPageId: string
  host: string
  port: number
  /** URL protocol of the challenged page (e.g. "https"), not the auth scheme. */
  protocol?: string
  realm?: string
}

export type BrowserBasicAuthResponse = {
  requestId: string
  cancelled: boolean
  username?: string
  password?: string
}

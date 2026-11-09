/** A site in the built-in browser asks for a username and password (HTTP basic or digest auth). */
export type BrowserHttpAuthPrompt = {
  /** Origin of the URL that answered with the challenge, e.g. `https://staging.acme.com`. */
  origin: string
  /** The site turned down the previous username and password. */
  retry: boolean
}

export type BrowserHttpAuthCredentials = {
  username: string
  password: string
}

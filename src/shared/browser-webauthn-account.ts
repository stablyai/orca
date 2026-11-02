export type BrowserWebAuthnAccount = {
  credentialId: string
  displayName?: string
  name?: string
}

export type BrowserWebAuthnAccountRequest = {
  requestId: string
  browserPageId: string
  relyingPartyId: string
  accounts: BrowserWebAuthnAccount[]
}

export type BrowserWebAuthnAccountResponse = {
  requestId: string
  credentialId: string | null
}

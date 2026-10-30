export type GoogleCookieClearResult = 'cleared' | 'empty' | 'remaining' | 'unverified'

export type GoogleCookieClearLocalTarget = {
  profileId: string
  environmentId: string | null
  partition: string
  routeIdentity: string | null
}

export type GoogleCookieClearLocalReceipt = { local: GoogleCookieClearLocalTarget; label: string }
export type GoogleCookieClearRemoteReceipt = {
  environmentId: string
  pairingRevision: number
  executorRuntimeId: string
  profileId: string
  label?: string
}
export type GoogleCookieClearTarget = GoogleCookieClearLocalReceipt | GoogleCookieClearRemoteReceipt

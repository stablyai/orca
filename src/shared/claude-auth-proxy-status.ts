/** Live auth-proxy snapshot. Slot ids are capabilities; this never carries a token. */
export type ClaudeAuthProxyStatus = {
  listening: boolean
  host: string
  port: number | null
  slots: { slot: string; accountId: string }[]
  requestsLastHour: { accountId: string; count: number }[]
  unknownSlotRequests: number
  lastError: {
    at: number
    method: string
    path: string
    status: number
    accountId: string | null
  } | null
}

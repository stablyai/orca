export const WEB_PAIRING_QUERY_KEYS = ['pairing', 'pair', 'code', 'token'] as const

export function stripWebPairingQuery(search: string): string {
  // Preserve the original encoding of query parameters used for proxy routing.
  const routingQuery = search
    .slice(1)
    .split('&')
    .filter((parameter) => {
      const entry = new URLSearchParams(`?${parameter}`)
      return !WEB_PAIRING_QUERY_KEYS.some((key) => entry.has(key))
    })
    .join('&')
  return routingQuery ? `?${routingQuery}` : ''
}

import { z } from 'zod'
import { normalizePairingUrl } from './network/pairing-url'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { openEnum } from './zod-salvage'

export const MAX_PAIRING_DIRECT_ENDPOINTS = 8
const addressSchema = z.union([z.ipv4(), z.ipv6()])

export function isPairingDirectEndpoint(value: string): boolean {
  if (normalizePairingUrl(value) !== value) {
    return false
  }
  const url = new URL(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  return (
    addressSchema.safeParse(hostname).success &&
    classifyRemotePairingHostname(hostname) !== 'loopback' &&
    !/^(?:0\.|169\.254\.|198\.(?:18|19)\.|::|fe[89ab][0-9a-f]:|ff[0-9a-f]{2}:)/i.test(hostname) &&
    !(url.hostname.includes('.') && Number(hostname.split('.')[0]) >= 224) &&
    url.pathname === '/' &&
    !url.search
  )
}

export const PairingDirectEndpointSchema = z.object({
  kind: openEnum(['lan', 'tailscale'], 'lan'),
  url: z.string().max(2048).refine(isPairingDirectEndpoint)
})

export const PairingGetDirectEndpointsParamsSchema = z.object({}).strict()
export const PairingGetDirectEndpointsResultSchema = z.object({
  v: z.literal(1),
  endpoints: z.array(PairingDirectEndpointSchema).max(MAX_PAIRING_DIRECT_ENDPOINTS)
})

export type PairingDirectEndpoint = z.infer<typeof PairingDirectEndpointSchema>
export type PairingGetDirectEndpointsResult = z.infer<typeof PairingGetDirectEndpointsResultSchema>

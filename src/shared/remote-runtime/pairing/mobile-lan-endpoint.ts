import * as z from 'zod'
import { classifyRemotePairingHostname } from './remote-pairing-address'

// Only accept literal private IPv4 WebSocket listeners; never treat an arbitrary internet URL as the LAN route.
export const MobileLanEndpointSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((endpoint) => {
    const match = /^wss?:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\/$/.exec(endpoint)
    if (!match) {
      return false
    }
    const octets = match[1]!.split('.').map(Number)
    const validIp = octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    const port = Number(match[2])
    return (
      validIp && classifyRemotePairingHostname(match[1]!) === 'lan' && port >= 1 && port <= 65535
    )
  }, 'Expected a private LAN WebSocket endpoint')

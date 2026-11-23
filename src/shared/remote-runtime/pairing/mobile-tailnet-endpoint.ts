import * as z from 'zod'
import { isTailnetIPv4Address } from '../../network/tailnet-address'

// Accept only a literal Tailscale WebSocket URL as an authenticated fallback route.
export const MobileTailnetEndpointSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((endpoint) => {
    // Match the literal form: URL parsing drops explicit default ports (80/443).
    const match = /^wss?:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\/$/.exec(endpoint)
    if (!match) {
      return false
    }
    const port = Number(match[2])
    return isTailnetIPv4Address(match[1]!) && port >= 1 && port <= 65535
  }, 'Expected a Tailscale WebSocket endpoint')

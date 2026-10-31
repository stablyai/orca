import { z } from 'zod'

export const MOBILE_BROWSER_TUNNEL_METHOD = 'network.mobileBrowserTunnel' as const
export const MOBILE_BROWSER_TUNNEL_UNSUBSCRIBE_METHOD =
  'network.mobileBrowserTunnel.unsubscribe' as const

// The workspace picks the network the page sees: this host, its WSL distro or its SSH target.
export const MobileBrowserTunnelParams = z.object({
  workspaceId: z.string().min(1).max(1024)
})

export const MobileBrowserTunnelUnsubscribeParams = z.object({
  subscriptionId: z.string().min(1).max(256)
})

export type MobileBrowserTunnelEvent =
  // subscriptionId names this tunnel for the unsubscribe method.
  | { type: 'ready'; tunnelGeneration: number; subscriptionId: string }
  | { type: 'closed'; tunnelGeneration: number }

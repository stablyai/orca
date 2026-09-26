import { z } from 'zod'

// Why this lives in shared rather than beside the handler: it is a wire contract a
// paired client encodes against, so both sides must compile from one definition and
// the generated RPC params catalog must be able to see it.

/** No fields today. The destination travels per-stream in the tunnel's Open frame,
 *  so an added field here would be a new optional one, which is the compatible
 *  category in docs/reference/remote-wire-compatibility.md. */
export const PortForwardAttachParams = z.object({}).strict()
export type PortForwardAttachParams = z.infer<typeof PortForwardAttachParams>

const TunnelGeneration = z.number().int().min(1).max(0xffff_ffff)

export const PortForwardEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), tunnelGeneration: TunnelGeneration }),
  z.object({ type: z.literal('closed'), tunnelGeneration: TunnelGeneration })
])
export type PortForwardEvent = z.infer<typeof PortForwardEvent>

import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'
import { TerminalViewport } from './terminal-unary-params'

export const TerminalHandle = z.object({ terminal: requiredString('Missing terminal handle') })

export const TerminalResizeForClient = z.discriminatedUnion('mode', [
  z.object({
    terminal: requiredString('Missing terminal handle'),
    mode: z.literal('mobile-fit'),
    cols: z.number().finite().positive(),
    rows: z.number().finite().positive(),
    clientId: requiredString('Missing client ID')
  }),
  z.object({
    terminal: requiredString('Missing terminal handle'),
    mode: z.literal('restore'),
    clientId: requiredString('Missing client ID')
  })
])

export const TerminalSubscribe = TerminalHandle.extend({
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop')
    })
    .optional(),
  viewport: TerminalViewport.optional(),
  capabilities: z
    .object({
      terminalBinaryStream: z.literal(1).optional(),
      desktopViewportClaims: z.literal(1).optional(),
      mobileInputLeaseOnly: z.literal(1).optional(),
      writeUnavailable: z.literal(1).optional()
    })
    .optional(),
  /**
   * The bytes a mobile snapshot may occupy once it is JSON, when the subscriber has a frame cap.
   *
   * Additive and optional, so no negotiation is involved: a host that predates it ignores the field
   * and trims on the raw byte budget it always did, and a subscriber that never sends one is served
   * exactly as before (Rule 1 of docs/reference/remote-wire-compatibility.md). The page sends it
   * because the shell measures the frame rather than the text, and an ANSI snapshot escapes every
   * ESC byte into six — a 512 KiB budgeted screen serializes past the 640 KiB bridge cap and ends
   * the stream before a live byte lands.
   *
   * Never inferred from `client.type`: a mobile subscriber on the socket has no frame cap at all,
   * and one that sends this has whatever cap its own transport imposes.
   */
  snapshotByteBudget: z.number().int().positive().optional()
})

export const TerminalMultiplex = z.object({})

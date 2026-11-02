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
  /** Budget the JSON frame, not raw text: ESC expands sixfold and can push a 512 KiB snapshot past a 640 KiB bridge cap.
   * Optional for legacy raw-byte trimming; never infer from client.type because mobile socket clients have no frame cap. */
  snapshotByteBudget: z.number().int().positive().optional()
})

export const TerminalMultiplex = z.object({})

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
    .optional()
})

export const TerminalMultiplex = z.object({})

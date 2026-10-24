import { z } from 'zod'
import { TerminalHandle } from './terminal-unary-params'
import { requiredString } from './rpc-param-primitives'

export const TerminalDraftClientParam = z.object({
  id: requiredString('Missing client ID').pipe(z.string().max(256)),
  type: z.enum(['mobile', 'desktop'])
})

export const TerminalDraftBegin = TerminalHandle.extend({
  client: TerminalDraftClientParam,
  // Why: explicit takeover is the only way an old editor loses its lease; it never happens silently.
  force: z.boolean().optional()
})

const TerminalDraftEdit = TerminalHandle.extend({
  client: TerminalDraftClientParam,
  epoch: z.number().int().positive(),
  // Opaque token minted by the agent adapter for the editor text this edit started from.
  baseToken: requiredString('Missing draft source token').pipe(z.string().max(512)),
  operationId: requiredString('Missing draft operation ID').pipe(z.string().max(256))
})

export const TerminalDraftSave = TerminalDraftEdit.extend({
  text: z.string()
})

export const TerminalDraftSubmit = TerminalDraftSave

export const TerminalDraftRelease = TerminalHandle.extend({
  client: TerminalDraftClientParam,
  epoch: z.number().int().positive()
})

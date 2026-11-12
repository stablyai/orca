import * as z from 'zod'
import { requiredString } from './rpc-param-primitives'

/** A desktop saw Codex's skip key typed into a terminal this host owns. */
export const TerminalInferCodexQuestionSkip = z.object({
  terminal: requiredString('Missing terminal handle'),
  /** The turn prompt the desktop's row showed; fences a keystroke from a later turn. */
  prompt: z.string().max(100_000)
})

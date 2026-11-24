import * as z from 'zod'
import { requiredString } from '../rpc-param-primitives'
import { TerminalHandle } from './terminal-unary-params'

export const TerminalSignal = TerminalHandle.extend({
  // Why additive like scanChildProcesses: a legacy host strips the intent and the
  // caller falls back to its previous interrupt delivery instead of failing Ctrl+C.
  signal: requiredString('Missing signal name').pipe(z.string().max(16))
})

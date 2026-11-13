import * as z from 'zod'
import { requiredString } from './rpc-param-primitives'

export const TerminalCloseTabById = z.object({
  worktree: requiredString('Missing worktree selector'),
  tabId: requiredString('Missing tab id')
})

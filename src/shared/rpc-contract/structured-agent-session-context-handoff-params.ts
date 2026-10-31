import { z } from 'zod'
import { JournalCursor } from './structured-agent-session-identifiers'

export const ContextHandoff = z.strictObject({
  context: z.string().min(1).max(65536),
  cursor: JournalCursor
})

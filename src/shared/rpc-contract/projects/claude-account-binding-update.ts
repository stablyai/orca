import { z } from 'zod'
import { normalizeClaudeAccountBinding } from '../../agent-accounts/claude/claude-account-binding'

/** Null clears the binding; a malformed one is dropped so it never becomes an account selection. */
export const ClaudeAccountBindingUpdate = z
  .unknown()
  .optional()
  .transform((value) =>
    value === undefined || value === null
      ? value
      : (normalizeClaudeAccountBinding(value) ?? undefined)
  )

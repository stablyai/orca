import { z } from 'zod'

// Why: the admission tier is part of the wire contract, so the literal union
// lives with the schema; src/main re-exports it instead of redeclaring it.
export type GitAdmissionTier = 'interactive' | 'status' | 'background'

export const OptionalGitAdmissionTier = z
  .unknown()
  .optional()
  .transform((value): GitAdmissionTier | undefined => {
    return value === 'interactive' || value === 'status' || value === 'background'
      ? value
      : undefined
  })

import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Keep the wire union canonical; main re-exports it.
export type GitAdmissionTier = 'interactive' | 'status' | 'background'

export const OptionalGitAdmissionTier = lazyZodSchema(() =>
  z
    .unknown()
    .optional()
    .transform((value): GitAdmissionTier | undefined => {
      return value === 'interactive' || value === 'status' || value === 'background'
        ? value
        : undefined
    })
)

import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** The previous orcad on this data root died on this boot without releasing its instance lock. */
export const OrcadUnexpectedExitSchema = lazyZodSchema(() =>
  z.object({
    pid: z.number().int().positive(),
    version: z.string().max(255),
    /** When the exited run took the lock. */
    acquiredAt: z.iso.datetime({ offset: true })
  })
)

export type OrcadUnexpectedExit = z.infer<typeof OrcadUnexpectedExitSchema>

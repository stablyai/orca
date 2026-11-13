// ENV-BUILD-CHURN (feature `environment-held`): the repo's environment wasn't used because its build is
// below the security floor; the workspace started from the current image without its setup.
import { z } from 'zod'

export const HostedEnvironmentHeldSchema = z
  .object({ environmentId: z.string().min(1).max(64), reason: z.literal('security_update') })
  .strict()

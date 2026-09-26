import { z } from 'zod'

export const WslManagedCliAvailabilityParams = z.object({
  distro: z.string().trim().min(1).optional()
})

import { z } from 'zod'

// Any params stay accepted, as when status.get declared none; only `probe: true` asks for the liveness reply.
export const StatusGetParams = z.preprocess(
  (params) =>
    typeof params === 'object' && params !== null && !Array.isArray(params) ? params : {},
  z.object({ probe: z.unknown().optional() })
)

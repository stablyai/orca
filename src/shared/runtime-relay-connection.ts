import { z } from 'zod'
import { MobileRelayEndpointSchema } from './mobile-relay-credential-contract'

export const RuntimeRelayConnectionSchema = MobileRelayEndpointSchema.extend({
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  credentialKind: z.enum(['invite', 'resume'])
}).strict()

export type RuntimeRelayConnection = z.infer<typeof RuntimeRelayConnectionSchema>

import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalPlainString, OptionalString } from '../rpc-param-primitives'

export const BitbucketConnectParam = lazyZodSchema(() =>
  z.object({
    authMode: z.enum(['token', 'basic']),
    accessToken: OptionalPlainString,
    email: OptionalPlainString,
    apiToken: OptionalPlainString,
    baseUrl: OptionalString
  })
)

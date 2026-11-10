import { z } from 'zod'
import { OptionalString } from './rpc-param-primitives'

/** `provider.list`: one repo's workspace providers, or every local repo's when omitted. */
export const ProviderList = z.object({ repo: OptionalString })

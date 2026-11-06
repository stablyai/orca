import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

export const LinkPreviewGetParams = z.object({
  url: requiredString('Missing url')
})

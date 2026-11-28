import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { requiredString } from '../rpc-param-primitives'

export const LinkPreviewGetParams = lazyZodSchema(() =>
  z.object({
    url: requiredString('Missing url')
  })
)

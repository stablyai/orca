import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

export const RequestShowParams = z.object({ request: requiredString('Missing --request') })

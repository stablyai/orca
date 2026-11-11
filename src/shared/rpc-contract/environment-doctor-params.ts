import * as z from 'zod'
import { requiredString } from './rpc-param-primitives'

/** A checkout path on the host. The RPC never re-runs setup: that executes repo code. */
export const EnvironmentDoctorParams = z.object({
  path: requiredString('Missing required path')
})

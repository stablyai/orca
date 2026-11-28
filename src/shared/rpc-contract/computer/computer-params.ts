import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const ComputerPermissionsStatusParams = lazyZodSchema(() => z.object({}))

export const ComputerCapabilitiesParams = lazyZodSchema(() => z.object({}))

import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const TerminalGetAutoRestoreFitParams = lazyZodSchema(() => z.object({}))

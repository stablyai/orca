import * as z from 'zod'
import { requiredString, OptionalString } from '../rpc-param-primitives'
import { AutomationId } from './automation-params'

export const AutomationShow = AutomationId.extend({ modelRecovery: z.boolean().optional() })

export const AutomationRecoverModel = AutomationId.extend({
  runId: requiredString('Missing run id'),
  expectedTarget: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1).max(512),
  callerSessionId: OptionalString
})

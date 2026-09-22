import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const WorkerResumeParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  /** One line appended to the resume prompt; the assignment itself is never restated here. */
  note: OptionalString
})

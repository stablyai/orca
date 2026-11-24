// Split out of structured-agent-session-params.ts, which is at its line limit.

import { z } from 'zod'
import { OptionsParams } from './structured-agent-session-params'

// Why `legacyAlias`: a window uploading a tab rename it saved before names lived on the host must
// not overwrite a rename the user has made since. The host trims and bounds `name` itself.
export const RenameParams = OptionsParams.extend({
  name: z.string().min(1).max(4096),
  legacyAlias: z.literal(true).optional()
}).strict()

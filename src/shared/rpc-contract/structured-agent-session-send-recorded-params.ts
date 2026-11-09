// Split out of structured-agent-session-params.ts, which is at its line limit.

import { Identifier, OptionsParams } from './structured-agent-session-params'

export const SendRecordedParams = OptionsParams.extend({
  clientMessageId: Identifier('Invalid client message id')
}).strict()

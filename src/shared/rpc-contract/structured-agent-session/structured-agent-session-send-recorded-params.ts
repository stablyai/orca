// Split out of structured-agent-session-params.ts, which is at its line limit.

// Split out of structured-agent-session-params.ts, which is at its line limit.
import { OptionsParams } from './structured-agent-session-params'
import { Identifier } from './structured-agent-session-identifiers'

export const SendRecordedParams = OptionsParams.extend({
  clientMessageId: Identifier('Invalid client message id')
}).strict()

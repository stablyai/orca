import { createStructuredAgentSessionOperationId } from '../../../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../../shared/non-secure-context-uuid'

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(createBrowserUuid)
}

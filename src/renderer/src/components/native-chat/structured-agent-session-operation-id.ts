import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { createBrowserUuid } from '@/lib/browser-uuid'

/** A fresh operation id for one structured chat write. */
export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(createBrowserUuid)
}

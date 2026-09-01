import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  agentAuthoringWriteFailureMessage,
  asAgentAuthoringWriteFailure,
  type AgentAuthoringWriteFailureCode
} from '@/components/settings/agent-authoring-write-failure'

// Why: quick commands and AI recipes are also authored from surfaces with no
// notice slot (tab bar, terminal pane, generation dialogs). Those durable-write
// rejections get the same copy through one toast id, so a burst of failed writes
// replaces rather than stacks.
const AGENT_AUTHORING_WRITE_FAILURE_TOAST_ID = 'agent-authoring-write-failed'

/** Toasts the shared "nothing was saved" copy for a durable-write rejection;
 *  returns the code so callers can also skip their own success affordance. */
export function notifyAgentAuthoringWriteFailure(result: {
  ok: boolean
}): AgentAuthoringWriteFailureCode | null {
  const code = asAgentAuthoringWriteFailure(result)
  if (!code) {
    return null
  }
  toast.error(
    translate(
      'auto.components.settings.AgentCatalogSection.writeFailedTitle',
      "Your change wasn't saved"
    ),
    {
      id: AGENT_AUTHORING_WRITE_FAILURE_TOAST_ID,
      description: agentAuthoringWriteFailureMessage()
    }
  )
  return code
}

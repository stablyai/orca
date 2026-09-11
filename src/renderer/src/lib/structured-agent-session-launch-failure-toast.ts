import { toast } from 'sonner'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { translate } from '@/i18n/i18n'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { PROVIDER_LOGIN_REQUIRED_SUPPORT_REASON } from '../../../shared/structured-agent-session-create-support-reason'
import {
  StructuredAgentSessionLaunchCancelledError,
  type StructuredAgentLaunchReceipt
} from '@/lib/structured-agent-session-launch-recovery'

/** Why one toast per launch, not per caller: coalesced callers share the launch and its failure. */
export function trackStructuredLaunchFailureToast(
  agent: AgentSessionHandleProvider,
  launchResult: Promise<StructuredAgentLaunchReceipt>,
  refusalSettlement: Promise<boolean>
): void {
  void launchResult.catch(async (error) => {
    if (error instanceof StructuredAgentSessionLaunchCancelledError) {
      return
    }
    const agentLabel = structuredAgentLabel(agent)
    if (
      error instanceof StructuredAgentSessionCreateRefusalError &&
      error.supportReason === PROVIDER_LOGIN_REQUIRED_SUPPORT_REASON
    ) {
      // Why: nothing on this client can fix it, so the message names the machine to fix it on.
      toast.error(
        translate(
          'components.native-chat.structuredSessionHostNotSignedIn',
          'Sign in to {{value0}} on the host',
          { value0: agentLabel }
        ),
        {
          description: translate(
            'components.native-chat.structuredSessionHostNotSignedInDescription',
            'The machine running this workspace has no {{value0}} login, so the chat would fail to authenticate. Sign in there, then try again.',
            { value0: agentLabel }
          )
        }
      )
      return
    }
    if (
      error instanceof StructuredAgentSessionCreateRefusalError &&
      (await refusalSettlement.catch(() => false))
    ) {
      // Why: the callback proves the fallback was attempted, not that its terminal became visible.
      toast.message(
        translate(
          'components.native-chat.structuredSessionFellBackToTerminal',
          "Structured chat isn't available"
        ),
        {
          description: translate(
            'components.native-chat.structuredSessionFellBackToTerminalDescription',
            'Orca tried to open a {{value0}} terminal instead.',
            { value0: agentLabel }
          )
        }
      )
      return
    }
    // Why: the raw error carries errnos and absolute paths; it belongs in the log, not the toast.
    console.warn('[native-chat] structured launch failed', error)
    toast.error(
      translate(
        'components.native-chat.structuredSessionLaunchFailed',
        'Could not open {{value0}} chat',
        {
          value0: agentLabel
        }
      ),
      {
        description: translate(
          'components.native-chat.structuredSessionLaunchFailedDescription',
          'Orca could not open a structured {{value0}} chat. See the logs for details.',
          { value0: agentLabel }
        )
      }
    )
  })
}

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { agentSessionThrownFailure } from '../../../../shared/agent-session-write-failure'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import { SessionOptionApplyError } from '../../../../shared/native-chat-session-option-apply-failure'
import { sessionOptionApplyErrorText } from './native-chat-session-option-apply-error-text'

/** Translate host log errors through the failure table; local errors are already user-facing. */
function optionUpdateFailureDescription(error: unknown): string {
  if (error instanceof RuntimeRpcCallError) {
    return agentSessionWriteFailureText(agentSessionThrownFailure(error, error.code), 'option')
  }
  if (error instanceof SessionOptionApplyError) {
    return sessionOptionApplyErrorText(error)
  }
  return error instanceof Error ? error.message : String(error)
}

export function runSessionOptionSurfaceCall<T>(
  pending: T,
  setPending: (pending: T | null) => void,
  call: () => Promise<unknown>
): void {
  setPending(pending)
  void call()
    .catch((error) => {
      toast.error(
        translate('components.native-chat.composer.optionUpdateFailed', 'Could not update option'),
        { description: optionUpdateFailureDescription(error) }
      )
    })
    .finally(() => setPending(null))
}

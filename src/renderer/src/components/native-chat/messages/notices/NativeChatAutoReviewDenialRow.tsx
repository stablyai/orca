import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { AgentSessionAutoReviewApprovalResult } from '../../../../../../shared/agent-session/requests/approvals/agent-session-auto-review-approval'
import type { CodexAutoReviewDenial } from '../../../../../../shared/agent-session/requests/approvals/codex-auto-review-denial'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import { NativeChatDetailsDisclosure } from '../diagnostics/NativeChatProviderDetails'
import {
  KEPT_PROMPT_VIEWS,
  useNativeChatViewGuard
} from '../../pane/ownership/native-chat-view-memory'

type ApprovalState = 'idle' | 'pending' | 'approved' | 'not-running' | 'failed'

/** An action the agent's automatic review denied; only the person, from this chat, may approve a retry. */
export function NativeChatAutoReviewDenialRow({
  denial,
  agent,
  itemId
}: {
  denial: CodexAutoReviewDenial
  agent: string
  itemId?: string
}): React.JSX.Element {
  const t = useTranslate()
  const owner = useNativeChatVisualOwner()
  // Kept with the chat tab: a row released mid-approval returns still approving, or with its answer. Only
  // answers count toward the newest few kept; an approval in flight is never dropped.
  const [pending, setPending] = useNativeChatViewGuard(`auto-review-pending:${itemId ?? ''}`, false)
  const [answer, setAnswer] = useNativeChatViewGuard<Exclude<ApprovalState, 'pending'>>(
    `auto-review:${itemId ?? ''}`,
    'idle',
    KEPT_PROMPT_VIEWS
  )
  const state: ApprovalState = pending ? 'pending' : answer
  // The host accepts an approval only from its own window, never over a pairing an agent could hold.
  const approvable = denial.event !== null && owner?.target.kind === 'local' && itemId !== undefined
  const approve = async (): Promise<void> => {
    if (!owner || !itemId) {
      return
    }
    setPending(true)
    // The answer is set before the guard clears, so the row never shows Approve again in between.
    await callRuntimeRpc<AgentSessionAutoReviewApprovalResult>(
      owner.target,
      'agentSession.approveAutoReviewDenial',
      { sessionId: owner.sessionId, itemId }
    )
      .then(
        ({ status }) =>
          setAnswer(
            status === 'approved' ? 'approved' : status === 'unavailable' ? 'not-running' : 'failed'
          ),
        () => setAnswer('failed')
      )
      .finally(() => setPending(false))
  }
  return (
    <div className="flex flex-col gap-1">
      <NativeChatDetailsDisclosure
        summary={t(
          'components.native-chat.notices.autoReviewDenied',
          "{{agent}}'s automatic review denied: {{action}}",
          { agent, action: denial.summary }
        )}
        bodyClassName="text-chat-warning"
      >
        {/* The row's summary truncates; the person sees the whole action before approving it. */}
        {`${denial.summary}\n\n`}
        {denial.rationale ??
          t('components.native-chat.notices.autoReviewNoReason', 'No reason was given.')}
      </NativeChatDetailsDisclosure>
      {approvable ? (
        <div className="flex items-center gap-2 px-2 text-xs text-chat-foreground-faint">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={state === 'pending' || state === 'approved'}
            onClick={() => void approve()}
          >
            <Check />
            {state === 'approved'
              ? t('components.native-chat.notices.autoReviewApproved', 'Approved')
              : t('components.native-chat.notices.autoReviewApprove', 'Approve once')}
          </Button>
          <span>
            {state === 'not-running'
              ? t(
                  'components.native-chat.notices.autoReviewApproveNotRunning',
                  "{{agent}} isn't running. Send it a message to start it, then approve again.",
                  { agent }
                )
              : state === 'failed'
                ? t(
                    'components.native-chat.notices.autoReviewApproveFailed',
                    "Couldn't record your approval. Try again."
                  )
                : t(
                    'components.native-chat.notices.autoReviewApproveHint',
                    '{{agent}} may retry this exact action once. Its review still checks the retry.',
                    { agent }
                  )}
          </span>
        </div>
      ) : null}
    </div>
  )
}

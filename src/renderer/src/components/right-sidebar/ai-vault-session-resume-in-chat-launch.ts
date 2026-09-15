import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { prepareAiVaultSessionForResume } from '@/lib/ai-vault-session-resume-preparation'
import { launchAgentSession } from '@/lib/launch-agent-session'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'

export function activateAiVaultResumeWorkspace(workspaceId: string): void {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    activateAndRevealFolderWorkspace(scope.folderWorkspaceId)
  } else {
    activateAndRevealWorktree(workspaceId)
  }
}

/** Adopt a vault conversation into a new structured chat. The eligibility gate chose this
 *  explicit surface, so the launch must not reapply the default route. No legacy fallback: resume
 *  has no terminal equivalent short of the resume command, and switching surface silently would
 *  hide the refusal the user needs to see. */
export async function resumeAiVaultSessionInNewChat(
  session: AiVaultSession,
  agent: AgentSessionHandleProvider,
  worktreeId: string
): Promise<void> {
  try {
    // Codex rows can live under a shared legacy home; the same preparation the terminal resume
    // runs re-pins them, and its result is what names the conversation the host will look for.
    const preparedSession = await prepareAiVaultSessionForResume(session)
    const outcome = await launchAgentSession({
      agent,
      workspaceId: worktreeId,
      routeIntent: 'structured-native-chat',
      resumeFrom: { providerSessionId: preparedSession.sessionId },
      visibility: 'reveal',
      launchSource: 'ai_vault_resume',
      terminalFallback: false
    })
    if (outcome.kind === 'failed') {
      notifyAiVaultSessionResumeInChatFailure(outcome.error)
    }
    // Why: unknown outcomes are deliberately silent; the launch layer reconciles them on retry.
  } catch (error) {
    notifyAiVaultSessionResumeInChatFailure(error)
  }
}

/** The host refuses an adoption whose conversation another chat already holds, and refuses one it
 *  cannot find under any account home it recognises. Both are actionable, and neither is the
 *  generic "could not prepare" the terminal resume reports. */
function notifyAiVaultSessionResumeInChatFailure(error: unknown): void {
  if (hasRuntimeRpcErrorCode(error, 'agent_session_conflict')) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
        'Another chat is already holding this conversation.'
      )
    )
    return
  }
  if (hasRuntimeRpcErrorCode(error, 'agent_session_identity_required')) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatTranscriptMissing',
        "This conversation's history could not be loaded, so it cannot be resumed in chat."
      )
    )
    return
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}

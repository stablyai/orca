import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { prepareAiVaultSessionForResume } from '@/lib/ai-vault-session-resume-preparation'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { structuredAgentSessionOwnerMatchesPairing } from '@/runtime/structured-agent-session-owner'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import type { AiVaultResumeInChatBlockedReason } from './ai-vault-session-resume-in-chat'
import { resolveAiVaultSessionResumeInChatOwner } from './ai-vault-session-resume-in-chat-owner'

export function activateAiVaultResumeWorkspace(workspaceId: string): void {
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
    return
  }
  activateAndRevealWorktree(workspaceId)
}

/** Adopt a vault conversation into a new structured chat. The route was decided by the
 *  eligibility gate that showed this action, so it re-enters as a verdict. No legacy fallback:
 *  resume has no terminal equivalent short of the resume command, and switching surface silently
 *  would hide the refusal the user needs to see. */
export async function resumeAiVaultSessionInNewChat(
  session: AiVaultSession,
  agent: AgentSessionHandleProvider,
  worktreeId: string
): Promise<void> {
  // Asked again here, on one synchronous store read, because the owner and its negotiated answer
  // are what decide whether `resumeFrom` may be sent at all. The gate that drew the action answered
  // the same question, and re-asking is what keeps a stale row from turning into a blind create.
  const ownerVerdict = resolveAiVaultSessionResumeInChatOwner({
    store: useAppStore.getState(),
    sessionExecutionHostId: session.executionHostId,
    sessionFilePath: session.filePath,
    targetWorkspaceId: worktreeId
  })
  if (!ownerVerdict.adoptable) {
    notifyAiVaultSessionResumeInChatUnavailable(ownerVerdict.reason)
    return
  }
  const { owner } = ownerVerdict
  try {
    // Codex rows can live under a shared legacy home; the same preparation the terminal resume
    // runs re-pins them, and its result is what names the conversation the host will look for.
    const preparedSession = await prepareAiVaultSessionForResume(session)
    // The pairing can have moved while that ran. Re-resolving the owner now would silently aim the
    // adoption at whatever machine answers to the id today, so the action is withdrawn instead.
    if (!structuredAgentSessionOwnerMatchesPairing(owner)) {
      notifyAiVaultSessionResumeInChatUnavailable('repaired')
      return
    }
    const settlement = await adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      agent,
      worktreeId,
      owner,
      resumeFrom: { providerSessionId: preparedSession.sessionId }
    }).launch({})
    if (settlement?.kind === 'failed') {
      notifyAiVaultSessionResumeInChatFailure(settlement.error)
      return
    }
    // Why: an unknown outcome is not a failure; the launch layer reconciles it on the next attempt.
    if (settlement?.kind !== 'structured') {
      return
    }
    if (useAppStore.getState().activeWorktreeId !== worktreeId) {
      activateAiVaultResumeWorkspace(worktreeId)
    }
  } catch (error) {
    notifyAiVaultSessionResumeInChatFailure(error)
  }
}

/** Nothing was sent. Each of these is a different thing to do about it, so none of them collapses
 *  into the generic failure below. */
function notifyAiVaultSessionResumeInChatUnavailable(
  reason: AiVaultResumeInChatBlockedReason | 'repaired'
): void {
  if (reason === 'owner-mismatch') {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatOwnerMismatch',
        'This conversation belongs to a different host. Open a workspace on that host to resume it.'
      )
    )
    return
  }
  if (reason === 'resume-history') {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatHostTooOld',
        "This conversation's host cannot resume a past conversation in a chat. Update it and try again."
      )
    )
    return
  }
  if (reason === 'repaired') {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatHostRepaired',
        "This conversation's host was reconnected while Orca was preparing the resume. Try again."
      )
    )
    return
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatUnavailable',
      'This conversation cannot be resumed in a chat right now.'
    )
  )
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

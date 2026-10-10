import { translate } from '@/i18n/i18n'
import { compactIpcErrorMessage } from '@/lib/ipc-error'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

/**
 * Where "Resume in New CLI" opens its copy of a conversation native chat owns, or null when the row
 * does not offer it. A row no chat owns already resumes in the CLI through plain Resume, and only
 * Claude and Codex can fork.
 */
export function aiVaultSessionCliForkWorktreeId(
  session: Pick<AiVaultSession, 'agent' | 'structuredSession'>,
  resume: { worktreeId: string | null | undefined; disabled: boolean }
): string | null {
  if (!session.structuredSession || resume.disabled || !resume.worktreeId) {
    return null
  }
  return session.agent === 'claude' || session.agent === 'codex' ? resume.worktreeId : null
}

/** The toast for a failed "Resume in New CLI". Only a host whose guard predates the fork refuses
 *  the fork as a second writer, so that refusal asks for the update instead of naming a code. */
export function describeAiVaultCliForkFailure(message: string): string {
  // The desktop preparation's refusal arrives inside Electron's IPC wrapper.
  const code = compactIpcErrorMessage(message)
  return code === 'agent_session_conflict' || code === 'agent_session_ownership_unknown'
    ? translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInNewCliHostTooOld',
        'Update Orca on the host that runs this chat to resume it in a new CLI.'
      )
    : message
}

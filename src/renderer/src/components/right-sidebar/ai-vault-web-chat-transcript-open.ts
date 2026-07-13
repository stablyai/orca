import { useAppStore } from '@/store'
import { isWebChatAgent, type AiVaultSession } from '../../../../shared/ai-vault-types'

/**
 * Open an imported web-chat session as a read-only native transcript tab.
 * Web-only: guarded so a non-web session never routes here (mirrors the resume
 * caller discipline). Needs an active workspace to host the tab.
 */
export function openWebChatSessionTranscript(
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'title'>
): void {
  if (!isWebChatAgent(session.agent)) {
    return
  }
  const worktreeId = useAppStore.getState().activeWorktreeId
  if (!worktreeId) {
    return
  }
  useAppStore.getState().openWebChatTranscript({
    agent: session.agent,
    sessionId: session.sessionId,
    title: session.title,
    worktreeId
  })
}

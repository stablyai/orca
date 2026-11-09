import { toast } from 'sonner'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { formatClipboardFilePath } from '@/lib/clipboard-file-path'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'
import { revealAiVaultSessionPath } from './ai-vault-session-path-actions'

async function copyText(text: string, label: string): Promise<void> {
  await window.api.ui.writeClipboardText(text)
  toast.success(
    translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
      value0: label
    })
  )
}

const staticRowHandlers = {
  onCopyId: (session: AiVaultSession) =>
    void copyText(
      session.sessionId,
      translate('auto.components.right.sidebar.AiVaultPanel.sessionId', 'Session ID')
    ),
  onCopyPath: (session: AiVaultSession) =>
    void copyText(
      formatClipboardFilePath(session.filePath, session.executionHostId),
      translate('auto.components.right.sidebar.AiVaultPanel.logPath', 'Log path')
    ),
  onOpenLog: (session: AiVaultSession) => void openAiVaultSessionLogInOrca(session),
  onRevealLog: (session: AiVaultSession) =>
    void revealAiVaultSessionPath(session, session.filePath),
  onOpenCwd: (session: AiVaultSession) => void revealAiVaultSessionPath(session, session.cwd),
  onRevealArtifacts: (session: AiVaultSession) =>
    void revealAiVaultSessionPath(session, session.antigravityArtifactPath ?? null)
}

/** Row action handlers that keep their identity across panel renders, so memoized rows can skip them. */
export function useAiVaultSessionRowHandlers({
  jumpToOriginalPane,
  onSessionOpened,
  copyResumeCommand,
  requestDelete
}: {
  jumpToOriginalPane: (session: AiVaultSession) => Promise<boolean>
  onSessionOpened?: () => void
  copyResumeCommand: (session: AiVaultSession, worktreeId?: string | null) => Promise<void>
  requestDelete: (session: AiVaultSession) => Promise<void>
}) {
  const onJumpToOriginalPane = useLatestHandler((session: AiVaultSession) => {
    void jumpToOriginalPane(session).then((opened) => {
      if (opened) {
        onSessionOpened?.()
      }
    })
  })
  const onCopyResume = useLatestHandler(
    (session: AiVaultSession, worktreeId?: string | null) =>
      void copyResumeCommand(session, worktreeId)
  )
  const onRequestDelete = useLatestHandler((session: AiVaultSession) => void requestDelete(session))
  return { ...staticRowHandlers, onJumpToOriginalPane, onCopyResume, onRequestDelete }
}

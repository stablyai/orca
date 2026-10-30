import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { detectLanguage } from '@/lib/language-detect'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { translate } from '@/i18n/i18n'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultSessionLogFilePath } from '../../../../shared/ai-vault-session-log-resource'
import { canUseLocalAiVaultSessionPathActions } from './ai-vault-session-path-actions'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type AiVaultLogSession = Pick<AiVaultSession, 'agent' | 'filePath' | 'executionHostId'>

function worktreeStillExists(state: AppState, worktreeId: string): boolean {
  if (findWorktreeById(selectWorktreesByRepo(state) ?? {}, worktreeId)) {
    return true
  }
  // Folder workspace IDs use a different key format from repo worktrees.
  return (selectFolderWorkspaces(state) ?? []).some(
    (workspace) => folderWorkspaceKey(workspace.id) === worktreeId
  )
}

function focusEditorContent(): void {
  // Double rAF lets the tab mount and Monaco attach its textarea before focusing for Find/selection/copy.
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return
  }
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.monaco-editor textarea')
      textarea?.focus()
    })
  })
}

/** Open a local log read-only via external-file openFile; preserve existing writable authority and never redirect to a remote host. */
export async function openAiVaultSessionLogInOrca(session: AiVaultLogSession): Promise<void> {
  const filePath = aiVaultSessionLogFilePath(session)
  // Silently reject unavailable paths; UI gating should already withhold them.
  if (!filePath || !canUseLocalAiVaultSessionPathActions(session.executionHostId)) {
    return
  }
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    toast.error(
      translate(
        'auto.components.right.sidebar.aiVaultSessionLogOpen.workspaceGone',
        "Couldn't open log — workspace is no longer available."
      )
    )
    return
  }
  const targetGroupId = state.activeGroupIdByWorktree?.[worktreeId] ?? undefined
  // View Log must preserve existing writable tabs; null runtime ownership matches the local tab it opens.
  const existingWritableTab = state.openFiles.find(
    (file) =>
      file.filePath === filePath &&
      file.mode === 'edit' &&
      file.worktreeId === worktreeId &&
      (file.runtimeEnvironmentId ?? null) === null &&
      file.readOnly !== true
  )

  if (!worktreeStillExists(state, worktreeId)) {
    toast.error(
      translate(
        'auto.components.right.sidebar.aiVaultSessionLogOpen.workspaceGone',
        "Couldn't open log — workspace is no longer available."
      )
    )
    return
  }

  state.openFile(
    {
      filePath,
      // An absolute relativePath makes the external-file contract read this exact path.
      relativePath: filePath,
      worktreeId,
      // Pin client-local ownership so the active runtime cannot reinterpret the path remotely.
      runtimeEnvironmentId: null,
      language: detectLanguage(filePath),
      mode: 'edit',
      readOnly: true,
      liveTail: true
    },
    {
      preview: false,
      // Refresh clean tabs; the store preserves dirty writable buffers.
      forceContentReload: true,
      suppressActiveRuntimeFallback: true,
      targetGroupId
    }
  )

  if (existingWritableTab) {
    toast(
      translate(
        'auto.components.right.sidebar.aiVaultSessionLogOpen.alreadyEditable',
        'Log is already open for editing.'
      )
    )
  }

  focusEditorContent()
}

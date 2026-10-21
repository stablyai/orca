import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { detectLanguage } from '@/lib/language-detect'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { translate } from '@/i18n/i18n'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { canOpenAiVaultSessionLogInOrca } from './ai-vault-session-path-actions'

type AiVaultLogSession = Pick<AiVaultSession, 'filePath' | 'executionHostId'>

function worktreeStillExists(state: AppState, worktreeId: string): boolean {
  if (findWorktreeById(state.worktreesByRepo ?? {}, worktreeId)) {
    return true
  }
  // Why: the AI Vault panel can be active inside a folder workspace, whose id is
  // keyed differently from repo worktrees.
  return (state.folderWorkspaces ?? []).some(
    (workspace) => folderWorkspaceKey(workspace.id) === worktreeId
  )
}

function focusEditorContent(): void {
  // Why: land keyboard focus in the editor so Find/selection/copy work
  // immediately. Double rAF lets the tab mount and Monaco attach its textarea
  // before we focus it (mirrors the modal return-focus surface selector).
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

/**
 * Open a local AI Vault session log inside Orca as a permanent, read-only editor
 * tab (or activate an existing tab without reducing its authority). Reuses
 * Orca's external-file `openFile` pipeline; it never grants write capability by
 * itself and never redirects the open to a remote host.
 */
export async function openAiVaultSessionLogInOrca(session: AiVaultLogSession): Promise<void> {
  const filePath = session.filePath?.trim()
  // Defensive: UI availability should already withhold blank/remote/synthetic
  // paths. Bail silently rather than toast — there is no user-actionable error.
  if (!filePath || !canOpenAiVaultSessionLogInOrca(session)) {
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
  // Why: an already-open *writable* tab must keep its edit authority — View Log
  // only activates it and notifies. Local ownership only (runtimeEnvironmentId
  // null) matches the tab this action would create/activate.
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
      // Why: keep relativePath === filePath so the external-file contract reads
      // the exact named path, not a worktree-relative reinterpretation.
      relativePath: filePath,
      worktreeId,
      // Why: the path was discovered on the client-local host — pin local
      // ownership so an active runtime can't reinterpret it as a remote path.
      runtimeEnvironmentId: null,
      language: detectLanguage(filePath),
      mode: 'edit',
      readOnly: true,
      liveTail: true
    },
    {
      preview: false,
      // Why: a repeated View Log refreshes a non-dirty tab; the store skips the
      // reload nonce for a dirty writable buffer (no buffer replacement).
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

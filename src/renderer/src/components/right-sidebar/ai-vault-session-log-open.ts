import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import { dshHomeFromSessionPath } from '../../../../shared/dsh-session-paths'
import { reasonixSessionLayout } from '../../../../shared/reasonix-session-paths'
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

// Why: rapid double-clicks of View Log during the authorize await must share one
// in-flight open (and toast-once on failure) so a slow FS grant can't spawn
// duplicate tabs or spam error toasts. Keyed by the exact requested path.
const inFlightOpenPaths = new Set<string>()

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

// Local logs use exact-path grants; SSH DSH logs retain their explicit host owner.
export async function openAiVaultSessionLogInOrca(session: AiVaultLogSession): Promise<void> {
  const filePath = session.filePath?.trim()
  // Defensive: UI availability already withholds unsupported source identities.
  if (!filePath || !canOpenAiVaultSessionLogInOrca(session)) {
    return
  }
  if (inFlightOpenPaths.has(filePath)) {
    return
  }
  inFlightOpenPaths.add(filePath)
  try {
    const state = useAppStore.getState()
    // Snapshot the invoking workspace/group before the authorization await so a
    // delayed grant can't retarget the tab into a workspace the user moved to.
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
    const host = parseExecutionHostId(session.executionHostId ?? 'local')
    const sshTargetId = host?.kind === 'ssh' ? host.targetId : undefined
    if (sshTargetId && getAiVaultResumeWorkspaceExecutionHostId(state, worktreeId) !== host?.id) {
      toast.error(
        translate(
          'auto.components.right.sidebar.aiVaultSessionLogOpen.openTranscriptHost',
          'Open a workspace on the transcript-owning SSH host to view this log.'
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
        (file.externalSshTargetId ?? undefined) === sshTargetId &&
        file.readOnly !== true
    )

    try {
      // The exact scanned path is the authorization oracle; the user click is the
      // trust gesture. Reuses Orca's existing external R/W open grant.
      if (!sshTargetId) {
        await window.api.fs.authorizeExternalPath({ targetPath: filePath })
      }
    } catch {
      toast.error(
        translate(
          'auto.components.right.sidebar.aiVaultSessionLogOpen.notAuthorized',
          "Couldn't open log — path not authorized."
        )
      )
      return
    }

    const stateAfterAuth = useAppStore.getState()
    if (
      !worktreeStillExists(stateAfterAuth, worktreeId) ||
      (sshTargetId &&
        getAiVaultResumeWorkspaceExecutionHostId(stateAfterAuth, worktreeId) !== host?.id)
    ) {
      toast.error(
        translate(
          'auto.components.right.sidebar.aiVaultSessionLogOpen.workspaceGone',
          "Couldn't open log — workspace is no longer available."
        )
      )
      return
    }

    stateAfterAuth.openFile(
      {
        filePath,
        // Why: keep relativePath === filePath so the external-file contract reads
        // the exact authorized path, not a worktree-relative reinterpretation.
        relativePath: filePath,
        worktreeId,
        // Why: the path was discovered on the client-local host — pin local
        // ownership so an active runtime can't reinterpret it as a remote path.
        runtimeEnvironmentId: null,
        ...(sshTargetId ? { externalSshTargetId: sshTargetId } : {}),
        language:
          dshHomeFromSessionPath(filePath) || reasonixSessionLayout(filePath)
            ? 'json'
            : detectLanguage(filePath),
        mode: 'edit',
        readOnly: true,
        liveTail: !sshTargetId && !reasonixSessionLayout(filePath)
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
  } finally {
    inFlightOpenPaths.delete(filePath)
  }
}

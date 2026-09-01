// SSH-aware resolution for composer attachments (STA-1465). The composer's
// attach surfaces (file drop, file picker, image paste) receive client-local
// paths, but an SSH worktree's agent runs on the remote host — local paths must
// be uploaded first, exactly like terminal drops (docs/terminal-drop-ssh.md).

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { reportTerminalDropUploadSkipsAndFailures } from '../terminal-pane/terminal-drop-upload-report'
import { uploadPathsToRuntimeDropDir } from '../terminal-pane/runtime-drop-dir-upload'
import {
  findTerminalTabWorktreeId,
  findWorktreeFallback,
  resolveNativeChatFileLinkContext
} from './native-chat-file-link'
import {
  captureDirectSshMutationExpectation,
  captureWorktreeSshMutationExpectation,
  type DirectSshMutationExpectation
} from '@/lib/ssh-mutation-expectation'

export type NativeChatSshAttachmentOwner = DirectSshMutationExpectation & {
  kind: 'ssh'
  connectionId: string
  worktreePath: string
}

export type NativeChatRuntimeAttachmentOwner = ReturnType<
  typeof captureWorktreeSshMutationExpectation
> & {
  kind: 'runtime'
  runtimeEnvironmentId: string
  worktreeId: string
  worktreePath: string
  /** Server-owned SSH connection when the worktree lives behind the
   *  runtime's own SSH target (nested topology, #17679). */
  connectionId: string | null
}

export type NativeChatAttachmentOwner =
  | { kind: 'local' }
  | NativeChatSshAttachmentOwner
  | NativeChatRuntimeAttachmentOwner
  /** Store not hydrated / worktree unknown. Callers must not attach local
   *  paths in this window — the worktree may turn out to be remote, and the
   *  agent would silently receive paths it cannot read (see #6648). */
  | { kind: 'not-ready' }

type NativeChatAttachmentOwnerState = Pick<
  AppState,
  | 'folderWorkspaces'
  | 'getKnownWorktreeById'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'sshConnectionStates'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
> &
  Partial<Pick<AppState, 'sshStateByEnvironment'>>

/** Resolve who owns the composer's backing worktree at attach time. Mirrors the
 *  terminal drop resolver's order: runtime owner first, then SSH vs local. */
export function resolveNativeChatAttachmentOwner(
  state: NativeChatAttachmentOwnerState,
  terminalTabId: string
): NativeChatAttachmentOwner {
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  if (!worktreeId) {
    return { kind: 'not-ready' }
  }
  return resolveNativeChatAttachmentOwnerForWorktree(state, worktreeId, terminalTabId)
}

export function resolveNativeChatAttachmentOwnerForWorktree(
  state: NativeChatAttachmentOwnerState,
  worktreeId: string,
  terminalTabId?: string
): NativeChatAttachmentOwner {
  // Both branches share the worktreesByRepo fallback so a capture through the
  // tab path and a later tab-less re-resolution (the stale-owner assert)
  // resolve the same path during index hydration.
  const resolveWorktreePath = (): string | undefined =>
    terminalTabId
      ? resolveNativeChatFileLinkContext(state, terminalTabId)?.worktreePath
      : (state.getKnownWorktreeById(worktreeId)?.path ??
        findWorktreeFallback(state.worktreesByRepo, worktreeId)?.path)
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (runtimeEnvironmentId) {
    const worktreePath = resolveWorktreePath()
    if (!worktreePath) {
      return { kind: 'not-ready' }
    }
    // An unresolved connection fails closed rather than coercing to "no
    // connection": in the hydration window a nested worktree (#17679) would
    // otherwise save attachments on the runtime server instead of its SSH
    // target. Mirrors the SSH branch below.
    const runtimeConnectionId = getConnectionIdFromState(state, worktreeId)
    if (runtimeConnectionId === undefined) {
      return { kind: 'not-ready' }
    }
    try {
      return {
        kind: 'runtime',
        runtimeEnvironmentId,
        worktreeId,
        worktreePath,
        connectionId: runtimeConnectionId,
        ...captureWorktreeSshMutationExpectation(state, worktreeId)
      }
    } catch {
      // Owner is mid-flip (SSH generation unknown) — fail closed like #6648.
      return { kind: 'not-ready' }
    }
  }
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId === undefined) {
    return { kind: 'not-ready' }
  }
  if (connectionId === null) {
    return { kind: 'local' }
  }
  const worktreePath = resolveWorktreePath()
  if (!worktreePath) {
    return { kind: 'not-ready' }
  }
  return {
    kind: 'ssh',
    connectionId,
    worktreePath,
    ...captureDirectSshMutationExpectation(state, connectionId)
  }
}

/** Where an attached path is readable — threaded onto attachment chips so
 *  previews read from the owning host instead of the client filesystem. */
export type NativeChatAttachedHost = {
  connectionId?: string | null
  runtime?: { runtimeEnvironmentId: string; worktreeId: string; worktreePath: string }
}

export function nativeChatWorktreeNotReadyNotice(): string {
  return translate(
    'components.native-chat.composer.worktreeNotReady',
    'Worktree not ready — try again in a moment.'
  )
}

function uploadingAttachmentsToast(pathCount: number): string | number {
  return toast.loading(
    translate(
      'components.native-chat.composer.uploadingAttachments',
      'Uploading {{value0}} file(s) to remote…',
      { value0: pathCount }
    )
  )
}

/**
 * Upload client-local paths into `${worktreePath}/.orca/drops` on the SSH
 * remote and return the remote paths the agent can read (input order
 * preserved). Returns null when the upload IPC itself failed; per-file
 * skips/failures surface through the shared drop toasts.
 */
export async function uploadNativeChatAttachmentPaths(
  paths: string[],
  owner: NativeChatSshAttachmentOwner
): Promise<string[] | null> {
  const pending = uploadingAttachmentsToast(paths.length)
  try {
    const { resolvedPaths, skipped, failed } = await window.api.fs.resolveDroppedPathsForAgent({
      paths,
      worktreePath: owner.worktreePath,
      connectionId: owner.connectionId,
      expectedExecutionHostId: owner.expectedExecutionHostId,
      expectedSshTargetId: owner.expectedSshTargetId,
      expectedSshConnectionGeneration: owner.expectedSshConnectionGeneration
    })
    reportTerminalDropUploadSkipsAndFailures(skipped, failed)
    return resolvedPaths
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
    return null
  } finally {
    toast.dismiss(pending)
  }
}

export const nativeChatAttachmentHostChangedMessage =
  'Attachment upload host changed; retry the attach.'

/**
 * True when two owner snapshots name the same execution host. Used to fence
 * async attach flows (uploads, clipboard saves) against the pane's ownership
 * changing mid-flight — a path minted on the old host must never be attached
 * for the new one. `not-ready` never matches: an unverifiable host is a
 * changed host.
 */
export function nativeChatAttachmentOwnersMatch(
  before: NativeChatAttachmentOwner,
  after: NativeChatAttachmentOwner
): boolean {
  if (before.kind === 'local' && after.kind === 'local') {
    return true
  }
  if (before.kind === 'ssh' && after.kind === 'ssh') {
    return (
      before.connectionId === after.connectionId &&
      before.worktreePath === after.worktreePath &&
      before.expectedExecutionHostId === after.expectedExecutionHostId &&
      before.expectedSshTargetId === after.expectedSshTargetId &&
      before.expectedSshConnectionGeneration === after.expectedSshConnectionGeneration
    )
  }
  if (before.kind === 'runtime' && after.kind === 'runtime') {
    return (
      before.runtimeEnvironmentId === after.runtimeEnvironmentId &&
      before.worktreeId === after.worktreeId &&
      before.connectionId === after.connectionId &&
      before.worktreePath === after.worktreePath &&
      before.expectedExecutionHostId === after.expectedExecutionHostId &&
      before.expectedSshTargetId === after.expectedSshTargetId &&
      before.expectedSshConnectionGeneration === after.expectedSshConnectionGeneration
    )
  }
  return false
}

function assertNativeChatRuntimeOwnerCurrent(owner: NativeChatRuntimeAttachmentOwner): void {
  const current = resolveNativeChatAttachmentOwnerForWorktree(
    useAppStore.getState(),
    owner.worktreeId
  )
  if (!nativeChatAttachmentOwnersMatch(owner, current)) {
    throw new Error(nativeChatAttachmentHostChangedMessage)
  }
}

/**
 * Upload client-local paths into `${worktreePath}/.orca/drops` on the runtime
 * host (over the pairing channel — the runtime forwards to its own SSH target
 * for nested worktrees) and return the destination-side paths. Mirrors the
 * terminal drop flow; returns null when the upload itself failed.
 */
export function uploadNativeChatRuntimeAttachmentPaths(
  paths: string[],
  owner: NativeChatRuntimeAttachmentOwner
): Promise<string[] | null> {
  return uploadPathsToRuntimeDropDir(paths, owner, {
    loadingMessage: translate(
      'components.native-chat.composer.uploadingAttachments',
      'Uploading {{value0}} file(s) to remote…',
      { value0: paths.length }
    ),
    assertCurrent: () => assertNativeChatRuntimeOwnerCurrent(owner)
  })
}

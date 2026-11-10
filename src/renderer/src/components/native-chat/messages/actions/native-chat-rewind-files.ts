import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import {
  agentSessionCheckpointPartialUndoIdOf,
  agentSessionCheckpointRefusalOf,
  type AgentSessionCheckpointPreview,
  type AgentSessionCheckpointRestoreResult
} from '../../../../../../shared/agent-session/lifecycle/agent-session-checkpoint'

/** The host's per-turn file checkpoints for one chat. */
export type NativeChatCheckpointClient = {
  preview: (itemId: string) => Promise<AgentSessionCheckpointPreview>
  restore: (itemId: string) => Promise<AgentSessionCheckpointRestoreResult>
  undo: (undoId: string) => Promise<AgentSessionCheckpointRestoreResult>
}

/** Past this the prompt opens without a files choice rather than keep the user waiting. */
export const NATIVE_CHAT_CHECKPOINT_PREVIEW_TIMEOUT_MS = 4_000

/** What the files would do on rewind; null when the host can't say in time (or is too old). */
export async function previewNativeChatRewindFiles(
  client: NativeChatCheckpointClient | undefined,
  itemId: string
): Promise<AgentSessionCheckpointPreview | null> {
  if (!client) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.preview(itemId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), NATIVE_CHAT_CHECKPOINT_PREVIEW_TIMEOUT_MS)
      })
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const BASE = () =>
  translate(
    'components.native-chat.rewind.confirmationBase',
    'Discard this message and everything after it? The message returns to the composer so you can edit and resend it.'
  )

function filesLabel(count: number): string {
  return translate(
    'components.native-chat.rewind.restoreFiles',
    'Also restore files ({{files}} changed)',
    { files: count }
  )
}

function filesDetail(headMoved: boolean): string {
  const detail = translate(
    'components.native-chat.rewind.restoreFilesDetail',
    'Files go back to how they were when this message was sent. Changes made after it are discarded. You can undo this.'
  )
  return headMoved
    ? `${detail} ${translate(
        'components.native-chat.rewind.restoreFilesCommitsStay',
        'Commits made since then stay on the branch.'
      )}`
    : detail
}

/** The prompt's wording and files choice; `choose` hears whether to restore files, on confirm. */
export function nativeChatRewindPrompt(
  preview: AgentSessionCheckpointPreview | null,
  choose: (restoreFiles: boolean) => void
): Pick<ConfirmationDialogOptions, 'description' | 'option'> {
  if (preview?.available && preview.changedFiles > 0) {
    return {
      description: BASE(),
      option: {
        label: filesLabel(preview.changedFiles),
        detail: filesDetail(preview.headMoved),
        defaultChecked: true,
        onConfirmed: choose
      }
    }
  }
  if (preview?.available) {
    return {
      description: `${BASE()} ${translate(
        'components.native-chat.rewind.filesAlreadyMatch',
        'Files on disk already match this message.'
      )}`
    }
  }
  return {
    description: translate(
      'components.native-chat.rewind.confirmation',
      'Discard this message and everything after it? The message returns to the composer so you can edit and resend it. File changes on disk are kept.'
    )
  }
}

function restoredText(count: number): string {
  return translate('components.native-chat.rewind.restored', 'Files restored ({{files}} changed)', {
    files: count
  })
}

function failureText(error: unknown): string {
  switch (agentSessionCheckpointRefusalOf(error)) {
    case 'busy':
      return translate(
        'components.native-chat.rewind.restoreBusy',
        "Files weren't restored because the agent is still working. Nothing on disk changed."
      )
    case 'merge-conflicts':
      return translate(
        'components.native-chat.rewind.restoreConflicts',
        "Files weren't restored because this worktree has unresolved merge conflicts. Nothing on disk changed."
      )
    case 'blocked-path':
      return translate(
        'components.native-chat.rewind.restoreBlocked',
        "Files weren't restored because a folder now sits where a restored file goes. Nothing on disk changed."
      )
    case 'none':
      return translate(
        'components.native-chat.rewind.restoreMissing',
        "Files weren't restored because the snapshot for this message is gone. Nothing on disk changed."
      )
    case 'partial':
      return translate(
        'components.native-chat.rewind.restorePartial',
        "Orca couldn't restore every file. Undo puts back the files it changed."
      )
    case 'not-a-repo':
    case 'unsafe-path':
    case null:
      return translate(
        'components.native-chat.rewind.restoreFailed',
        "Orca couldn't restore every file. Check the worktree before continuing."
      )
  }
}

/** Restores after the chat rewound, then offers Undo for the files. */
export async function restoreNativeChatRewindFiles(
  client: NativeChatCheckpointClient,
  itemId: string
): Promise<void> {
  let result: AgentSessionCheckpointRestoreResult
  try {
    result = await client.restore(itemId)
  } catch (error) {
    console.warn('[native-chat-rewind] file restore failed', error)
    const undoId = agentSessionCheckpointPartialUndoIdOf(error)
    toast.error(
      failureText(error),
      undoId ? { action: undoAction(client, undoId), duration: Infinity } : undefined
    )
    return
  }
  toast.success(restoredText(result.changedFiles), { action: undoAction(client, result.undoId) })
}

function undoAction(client: NativeChatCheckpointClient, undoId: string) {
  return {
    label: translate('components.native-chat.rewind.undoRestore', 'Undo'),
    onClick: () => void undoNativeChatRewindFiles(client, undoId)
  }
}

async function undoNativeChatRewindFiles(
  client: NativeChatCheckpointClient,
  undoId: string
): Promise<void> {
  try {
    await client.undo(undoId)
    toast.success(
      translate(
        'components.native-chat.rewind.undoneRestore',
        'Files are back to how they were before the rewind.'
      )
    )
  } catch (error) {
    console.warn('[native-chat-rewind] file restore undo failed', error)
    toast.error(failureText(error))
  }
}

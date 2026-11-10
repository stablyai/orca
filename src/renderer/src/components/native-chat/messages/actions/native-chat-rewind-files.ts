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
    'components.native-chat.rewind.removedDescription',
    'This message and everything after it are removed from the chat. The message goes back to the composer so you can edit and resend it.'
  )

function filesLabel(count: number): string {
  return translate(
    'components.native-chat.rewind.restoreChangedFiles',
    'Also restore {{count}} changed files',
    { count, defaultValue_one: 'Also restore {{count}} changed file' }
  )
}

function checkedDetail(headMoved: boolean): string {
  const detail = translate(
    'components.native-chat.rewind.restoreFilesOutcome',
    'Files go back to how they were when this message was sent. Later changes are discarded. You can undo the file restore afterwards.'
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
    const busy = preview.busy === true
    return {
      description: BASE(),
      option: {
        label: filesLabel(preview.changedFiles),
        detail: busy
          ? translate(
              'components.native-chat.rewind.restoreFilesBusy',
              "Files can't be restored while the agent is working."
            )
          : checkedDetail(preview.headMoved),
        uncheckedDetail: busy
          ? undefined
          : translate(
              'components.native-chat.rewind.keepFilesOutcome',
              'Files on disk stay as they are.'
            ),
        defaultChecked: !busy,
        disabled: busy,
        onConfirmed: (checked) => choose(checked && !busy)
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
  return translate('components.native-chat.rewind.restoredFiles', 'Restored {{count}} files', {
    count,
    defaultValue_one: 'Restored {{count}} file'
  })
}

function failureText(error: unknown): string {
  switch (agentSessionCheckpointRefusalOf(error)) {
    case 'busy':
      return translate(
        'components.native-chat.rewind.chatRewoundBusy',
        "The chat was rewound, but files weren't restored because the agent is still working. Nothing on disk changed."
      )
    case 'merge-conflicts':
      return translate(
        'components.native-chat.rewind.chatRewoundConflicts',
        "The chat was rewound, but files weren't restored because this workspace has unresolved merge conflicts. Nothing on disk changed."
      )
    case 'blocked-path':
      return translate(
        'components.native-chat.rewind.chatRewoundBlocked',
        "The chat was rewound, but files weren't restored because a folder now sits where a restored file goes. Nothing on disk changed."
      )
    case 'none':
      return translate(
        'components.native-chat.rewind.chatRewoundMissing',
        "The chat was rewound, but files weren't restored because Orca no longer has the files saved for this message. Nothing on disk changed."
      )
    case 'partial':
    case 'not-a-repo':
    case 'unsafe-path':
    case null:
      return translate(
        'components.native-chat.rewind.chatRewoundFailed',
        "The chat was rewound, but some files couldn't be restored. Check Source Control before you continue."
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
  toast.success(restoredText(result.changedFiles), {
    action: undoAction(client, result.undoId)
  })
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

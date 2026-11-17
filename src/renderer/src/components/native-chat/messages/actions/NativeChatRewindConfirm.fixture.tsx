import { useEffect } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import type { AgentSessionCheckpointPreview } from '../../../../../../shared/agent-session/lifecycle/agent-session-checkpoint'
import { nativeChatRewindPrompt } from './native-chat-rewind-files'
import { restoreNativeChatFilesOnly } from './native-chat-restore-files-only'

function OpenRewindPrompt({ preview }: { preview: AgentSessionCheckpointPreview | null }) {
  const confirm = useConfirmationDialog()
  useEffect(() => {
    void confirm({
      title: 'Rewind to here?',
      ...nativeChatRewindPrompt(preview, () => {}),
      confirmLabel: 'Rewind',
      cancelLabel: 'Cancel',
      confirmVariant: 'destructive',
      initialFocus: 'cancel'
    })
  }, [confirm, preview])
  return null
}

function prompt(preview: AgentSessionCheckpointPreview | null) {
  return defineFixture({
    width: 560,
    render: () => (
      <div className="h-[340px]">
        <ConfirmationDialogProvider>
          <OpenRewindPrompt preview={preview} />
        </ConfirmationDialogProvider>
      </div>
    )
  })
}

/** A: a snapshot exists and files differ. */
export const restoreFiles = prompt({
  available: true,
  changedFiles: 6,
  paths: [
    'src/app.ts',
    'src/features/billing/invoice.ts',
    'src/features/billing/invoice.test.ts',
    'notes/todo.md',
    'package.json',
    'README.md'
  ],
  headMoved: true,
  createdAt: 0
})
/** A, one file: the singular label. */
export const restoreOneFile = prompt({
  available: true,
  changedFiles: 1,
  headMoved: false,
  createdAt: 0
})
/** A while an agent works in the workspace: the choice is off and says why. */
export const restoreBusy = prompt({
  available: true,
  changedFiles: 3,
  headMoved: false,
  createdAt: 0,
  busy: true
})
/** B: files already match the message. */
export const filesMatch = prompt({
  available: true,
  changedFiles: 0,
  headMoved: false,
  createdAt: 0
})
/** C: no snapshot (older message, older host, or not git). */
export const noSnapshot = prompt({ available: false, reason: 'none' })

/** Files only, from a user message's menu: the chat stays as it is. */
export const restoreFilesOnly = defineFixture({
  width: 560,
  render: () => (
    <div className="h-[340px]">
      <ConfirmationDialogProvider>
        <OpenFilesOnlyPrompt />
      </ConfirmationDialogProvider>
    </div>
  )
})

function OpenFilesOnlyPrompt() {
  const confirm = useConfirmationDialog()
  useEffect(() => {
    void restoreNativeChatFilesOnly(
      {
        preview: async () => ({
          available: true,
          changedFiles: 2,
          paths: ['src/app.ts', 'notes/todo.md'],
          headMoved: false,
          createdAt: 0
        }),
        restore: async () => ({ changedFiles: 2, headMoved: false, undoId: '0-00000000' }),
        undo: async () => ({ changedFiles: 2, headMoved: false, undoId: '0-00000001' })
      },
      'item',
      confirm
    )
  }, [confirm])
  return null
}

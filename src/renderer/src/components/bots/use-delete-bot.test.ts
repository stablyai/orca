import { describe, expect, it, vi } from 'vitest'
import { makeTestBot } from '../../../../main/bots/bot.test-fixture'

const { toastError, deleteBot } = vi.hoisted(() => ({
  toastError: vi.fn(),
  deleteBot: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/bot-catalog', () => ({ deleteBot }))
vi.mock('@/store/folder-workspaces/folder-workspace-record-index', () => ({
  selectFolderWorkspaceOnHost: () => ({ id: 'w1', folderPath: '/bots/reviewer' })
}))
// As the store's delete does: a failed remove() comes back only as false.
vi.mock('@/components/sidebar/workspace-actions/deletion/folder-workspace-delete', () => ({
  deleteFolderWorkspaceUnlessUnsaved: async (
    _getState: unknown,
    _id: string,
    _hostId: string,
    options: { remove: () => Promise<boolean> }
  ) => options.remove().catch(() => false)
}))

import { useDeleteBot } from './use-delete-bot'

describe('useDeleteBot', () => {
  it("shows the host's unsaved-drafts refusal rather than the generic error", async () => {
    deleteBot.mockRejectedValueOnce(
      new Error('Unsaved editor changes. Save or close them in Orca, then delete again.')
    )

    expect(await useDeleteBot(makeTestBot())()).toBe(false)
    expect(toastError).toHaveBeenCalledWith(
      'Its folder has unsaved editor changes. Save or close them, then delete again.'
    )
  })
})

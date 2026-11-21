import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'

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

const bot: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

describe('useDeleteBot', () => {
  it("shows the host's unsaved-drafts refusal rather than the generic error", async () => {
    deleteBot.mockRejectedValueOnce(
      new Error('Unsaved editor changes. Save or close them in Orca, then delete again.')
    )

    expect(await useDeleteBot(bot)()).toBe(false)
    expect(toastError).toHaveBeenCalledWith(
      'Its folder has unsaved editor changes. Save or close them, then delete again.'
    )
  })
})

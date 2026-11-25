// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  closeNativeChatComposerNoticeRoute,
  deferNativeChatComposerNotice,
  hasDeferredNativeChatComposerNotice,
  openNativeChatComposerNoticeRoute
} from '@/components/native-chat/composer/controls/native-chat-deferred-composer-notice'
import type { NativeChatComposerDraftOwner } from '@/components/native-chat/drafts/native-chat-composer-draft-storage'
import { WORKTREE_ID_SEPARATOR } from '../../../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import {
  deleteProjectChatDrafts,
  deleteWorkspaceChatDraftOwners
} from './removed-worktree-chat-drafts'

// Removal paths that skip the full draft sweep (a same-ID survivor on another host, project removal)
// still retire paste feedback kept for the removed workspace, judged by the notice's confirmed owner,
// and leave the surviving host's feedback alone.
it('retires a removed workspace feedback on the owner-only and project removal paths', () => {
  const workspaceId = `notice-repo${WORKTREE_ID_SEPARATOR}/wt`
  const removed: NativeChatComposerDraftOwner = { workspaceId, executionHostId: 'local' }
  const survivor: NativeChatComposerDraftOwner = { workspaceId, executionHostId: 'ssh:other' }
  const route = openNativeChatComposerNoticeRoute('notice-removed-route', removed)
  deferNativeChatComposerNotice('notice-survivor', 'Image paste failed.', undefined, survivor)

  deleteWorkspaceChatDraftOwners({ owners: [removed], conversations: [], terminalTabIds: [] })
  expect(closeNativeChatComposerNoticeRoute(route)).toBeNull()
  expect(hasDeferredNativeChatComposerNotice('notice-survivor')).toBe(true)

  deferNativeChatComposerNotice('notice-project', 'Image paste failed.', undefined, removed)
  deleteProjectChatDrafts('notice-repo', 'local')
  expect(hasDeferredNativeChatComposerNotice('notice-project')).toBe(false)
  expect(hasDeferredNativeChatComposerNotice('notice-survivor')).toBe(true)
})

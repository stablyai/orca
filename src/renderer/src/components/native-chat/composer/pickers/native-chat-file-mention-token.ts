import { useAppStore } from '@/store/index'
import { relativePathInsideRoot } from '../../../../../../shared/file-access/cross-platform-path'
import { formatNativeChatFileReference } from '../../../../../../shared/native-chat/input/composer/agent-image-paste'
import { mentionPathFromChatFolder } from '../../../../../../shared/native-chat/input/composer/native-chat-mention-folder'
import { findNativeChatTabOwnerWorktreeId } from '../../pane/ownership/native-chat-tab-owner'
import {
  resolveNativeChatSessionFolder,
  resolveNativeChatTabDirectory
} from '../../pane/routing/native-chat-tab-directory'

/** The `@` token for a picked workspace file, written from the sub-folder the chat runs in; undefined
 *  keeps the workspace-relative default. Read at pick time, so typing subscribes to nothing. */
export function nativeChatFileMentionToken(tabId: string, path: string): string | undefined {
  const state = useAppStore.getState()
  const worktreeId = findNativeChatTabOwnerWorktreeId(state, tabId)
  const folder = worktreeId && resolveNativeChatSessionFolder(state, tabId, worktreeId)
  const root = folder && resolveNativeChatTabDirectory(state, tabId, worktreeId)
  const inside = folder && root ? relativePathInsideRoot(root, folder) : null
  return inside ? formatNativeChatFileReference(mentionPathFromChatFolder(path, inside)) : undefined
}

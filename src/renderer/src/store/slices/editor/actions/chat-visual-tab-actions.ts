import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import { buildChatVisualTabId } from '@/components/native-chat/native-chat-visual-tab'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'

export function createChatVisualTabActions(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openChatVisualTab'> {
  return {
    openChatVisualTab: (worktreeId, visual) => {
      const id = buildChatVisualTabId(worktreeId, visual)
      const label = visual.title ?? visual.file
      const file: OpenFile = {
        id,
        filePath: id,
        relativePath: label,
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'chat-visual',
        chatVisual: visual
      }
      set((s) => ({
        // Replacing an open record takes the newest title a later message gave the visual.
        openFiles: s.openFiles.some((f) => f.id === id)
          ? s.openFiles.map((f) => (f.id === id ? file : f))
          : [...s.openFiles, file],
        ...buildEditorActiveResult(s, worktreeId, id)
      }))
      // Why: focus the visual in whichever split holds it; default placement targets the chat's group and would add a second tab there.
      const openTab = (get().unifiedTabsByWorktree?.[worktreeId] ?? []).find(
        (tab) => tab.contentType === 'chat-visual' && tab.entityId === id
      )
      if (openTab && openTab.label !== label) {
        get().setTabLabel?.(openTab.id, label)
      }
      void openWorkspaceEditorItem(
        get(),
        id,
        worktreeId,
        label,
        'chat-visual',
        undefined,
        openTab?.groupId
      )
    }
  }
}

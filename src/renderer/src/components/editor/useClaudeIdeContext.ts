/**
 * useClaudeIdeContext
 *
 * Subscribes to IPC channels sent by the main-process IpcBridge and replies
 * with editor state so the Claude Code CLI can query the renderer.
 *
 * Stubbed fields (safe defaults, documented):
 *   - getCurrentSelection → null
 *     Reason: Monaco/CodeMirror selection lives inside the editor component
 *     and is not reflected in the Zustand store. A future iteration could
 *     expose it via a ref registry or a store field updated on selectionChange.
 *   - saveDocument → triggers save event then replies null immediately
 *     (the underlying save is async; reply is sent after dispatch, not after
 *     the file is flushed to disk — acceptable for Phase 2).
 */
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { requestEditorFileSave } from './editor-autosave'
import { openEditorsPayload } from './claude-ide-context'
import { getActiveIdeSelection } from './active-ide-selection'

type RequestPayload = { worktreeId: string; requestId: string; [k: string]: unknown }

// Why: renderer code cannot use Node's path module; worktree paths may use
// either separator depending on platform (Windows uses backslash).
function relativeToRoot(absolutePath: string, root: string): string {
  for (const sep of ['/', '\\']) {
    if (root && absolutePath.startsWith(root + sep)) {
      return absolutePath.slice(root.length + 1)
    }
  }
  return absolutePath
}

function sendDataReply(worktreeId: string, requestId: string, value: unknown): void {
  window.api.claudeIde.reply({ kind: 'data', worktreeId, requestId, value })
}

export function useClaudeIdeContext(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []

    // getCurrentSelection — reads the last selection set by MonacoEditor
    unsubs.push(
      window.api.claudeIde.onRequest('claudeIde:getCurrentSelection', (data: RequestPayload) => {
        sendDataReply(data.worktreeId, data.requestId, getActiveIdeSelection())
      })
    )

    // getOpenEditors — real: read from openFiles store
    unsubs.push(
      window.api.claudeIde.onRequest('claudeIde:getOpenEditors', (data: RequestPayload) => {
        const openFiles = useAppStore.getState().openFiles
        const editors = openEditorsPayload(
          openFiles
            .filter((f) => f.mode === 'edit')
            .map((f) => ({ path: f.filePath, dirty: f.isDirty }))
        )
        sendDataReply(data.worktreeId, data.requestId, editors)
      })
    )

    // checkDocumentDirty — real: look up the file in the store
    unsubs.push(
      window.api.claudeIde.onRequest('claudeIde:checkDocumentDirty', (data: RequestPayload) => {
        const path = data['path'] as string | undefined
        const openFiles = useAppStore.getState().openFiles
        const file = openFiles.find((f) => f.filePath === path)
        sendDataReply(data.worktreeId, data.requestId, file?.isDirty ?? false)
      })
    )

    // saveDocument — dispatches save event for the matching file, then replies
    unsubs.push(
      window.api.claudeIde.onRequest('claudeIde:saveDocument', (data: RequestPayload) => {
        const path = data['path'] as string | undefined
        const openFiles = useAppStore.getState().openFiles
        const file = openFiles.find((f) => f.filePath === path)
        if (file) {
          void requestEditorFileSave({ fileId: file.id })
        }
        sendDataReply(data.worktreeId, data.requestId, null)
      })
    )

    // openFile — real: call store openFile action
    unsubs.push(
      window.api.claudeIde.onRequest('claudeIde:openFile', (data: RequestPayload) => {
        const path = data['path'] as string | undefined
        if (path) {
          const state = useAppStore.getState()
          const activeWorktreeId = state.activeWorktreeId
          const worktree = activeWorktreeId
            ? state.getKnownWorktreeById(activeWorktreeId)
            : undefined
          if (worktree && activeWorktreeId) {
            const relativePath = worktree.path ? relativeToRoot(path, worktree.path) : path
            state.openFile({
              filePath: path,
              relativePath,
              worktreeId: activeWorktreeId,
              language: 'plaintext',
              mode: 'edit',
            })
          }
        }
        sendDataReply(data.worktreeId, data.requestId, null)
      })
    )

    // getWorkspaceFolders — real: collect unique worktree root paths
    unsubs.push(
      window.api.claudeIde.onRequest('claudeIde:getWorkspaceFolders', (data: RequestPayload) => {
        const state = useAppStore.getState()
        const allWorktrees = Object.values(state.worktreesByRepo).flat()
        const folders = [...new Set(allWorktrees.map((w) => w.path).filter(Boolean))]
        sendDataReply(data.worktreeId, data.requestId, folders)
      })
    )

    return () => {
      for (const unsub of unsubs) {unsub()}
    }
  }, [])
}

// Editor tabs this desktop opened in a paired server's workspace while it mirrored it (the 3a list)
// go to that server's main before its frames draw the workspace (H5d): frames list only the
// server's tabs, so gating first would drop these with their open files and drafts.

import type { AppState } from '@/store/types'
import { editorTabContent } from '@/store/slices/editor/tabs/editor-tab-open-through-layout-owner'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { sendToServerMain, type WindowLayoutCommand } from './layout-apply-send'
import { serverEditorOpen } from './server-layout-apply'
import { closeWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'

type EditorOpen = Extract<WindowLayoutCommand, { type: 'openEditorTab' }>

/** One server stream's hand-overs; a new stream starts with none. */
export type ServerEditorHandover = {
  /** Whether a workspace not yet gated may gate now; if not, hands its desktop-only tabs over. */
  admits: (key: string) => boolean
  /** The stream is gone: answers still to come change nothing. */
  close: () => void
}

/**
 * The editor tabs the window shows in a workspace that the server's layout does not list, as
 * opens under their own ids, in tab order. A file the mirror drew from the server is the server's.
 */
function desktopOnlyEditorOpens(
  state: AppState,
  key: string,
  layout: PublishedWorkspaceLayout | undefined
): EditorOpen[] {
  const listed = new Set(layout?.tabs.map((tab) => tab.id))
  const tabs = new Map((state.unifiedTabsByWorktree[key] ?? []).map((tab) => [tab.id, tab]))
  const order = new Set((state.groupsByWorktree[key] ?? []).flatMap((group) => group.tabOrder))
  return [...order].flatMap((tabId) => {
    const tab = tabs.get(tabId)
    if (!tab || listed.has(tab.id) || !isEditorTabContentType(tab.contentType)) {
      return []
    }
    const file = state.openFiles.find((open) => open.id === tab.entityId && open.worktreeId === key)
    if (!file || file.mirroredFromRuntimeSession === true) {
      return []
    }
    return [
      {
        type: 'openEditorTab',
        tabId: tab.id,
        fileId: tab.entityId,
        contentType: tab.contentType,
        ...editorTabContent(file),
        // A group only this desktop drew is not the server's: its main then places the tab itself.
        ...(layout?.groups.some((group) => group.id === tab.groupId)
          ? { groupId: tab.groupId }
          : {}),
        ...(tab.isPreview ? { preview: true } : {}),
        createdAt: tab.createdAt
      }
    ]
  })
}

/** Whether the window still shows the tab with this desktop's own file, not a mirror's copy. */
function showsDesktopTab(
  state: AppState,
  key: string,
  open: Pick<EditorOpen, 'tabId' | 'fileId'>
): boolean {
  return (state.unifiedTabsByWorktree[key] ?? []).some(
    (tab) => tab.id === open.tabId && tab.entityId === open.fileId
  )
}

/**
 * Hands a workspace's desktop-only editor tabs to the server's main, then reports when all have
 * answered. A resent open the server already applied answers ok (drawnTabOpen); any refusal, even
 * `tab_exists` (the id is another tab's there), or a failed call, keeps the workspace mirror-drawn
 * for the rest of this stream. A tab the user closed after its open was sent is closed on the server
 * before the workspace gates, so its frames never draw it back.
 */
export function createServerEditorHandover(options: {
  environmentId: string
  getState: () => AppState
  serverLayout: (key: string) => PublishedWorkspaceLayout | undefined
  /** A workspace's hand-overs all answered: it may gate now. */
  onAnswered: () => void
}): ServerEditorHandover {
  /** Per workspace: each handed-over tab's id and this desktop's file id for it. */
  const handedOver = new Map<string, Map<string, string>>()
  const waiting = new Map<string, number>()
  const notGateable = new Set<string>()
  let closed = false

  const answered = (key: string): void => {
    const left = (waiting.get(key) ?? 1) - 1
    if (left > 0) {
      waiting.set(key, left)
      return
    }
    waiting.delete(key)
    options.onAnswered()
  }

  /** The server holds a tab the user closed meanwhile: its close goes there too. */
  const closeOnServer = (key: string, tabId: string): void => {
    void closeWebRuntimeSessionTab({
      worktreeId: key,
      tabId,
      environmentId: options.environmentId,
      reason: 'user'
    }).then((outcome) => {
      if (closed) {
        return
      }
      if (outcome === 'failed') {
        // A gate now would draw the server's copy back; an undelivered close replays meanwhile.
        console.warn('[layout-owner] a closed editor tab could not be closed on the server')
        notGateable.add(key)
      }
      answered(key)
    })
  }

  const answer =
    (key: string, open: EditorOpen) =>
    (reply: LayoutApplyReply | null): void => {
      if (closed) {
        return
      }
      if (reply?.ok && !showsDesktopTab(options.getState(), key, open)) {
        closeOnServer(key, open.tabId)
        return
      }
      if (reply?.ok) {
        const tabs = handedOver.get(key) ?? new Map<string, string>()
        handedOver.set(key, tabs.set(open.tabId, open.fileId))
      } else {
        console.warn(
          '[layout-owner] an editor tab stays on this desktop:',
          reply?.code ?? 'call_failed'
        )
        notGateable.add(key)
      }
      answered(key)
    }

  return {
    admits: (key) => {
      if (closed || notGateable.has(key) || waiting.has(key)) {
        return false
      }
      // Recomputed on each ask: a tab opened meanwhile goes too, and a tab closed meanwhile does not.
      const state = options.getState()
      const tabs = handedOver.get(key)
      const opens = desktopOnlyEditorOpens(state, key, options.serverLayout(key)).filter(
        (open) => !tabs?.has(open.tabId)
      )
      // Handed over, then closed here before the gate: the server's frames would draw it back.
      const closedSince = [...(tabs ?? [])].flatMap(([tabId, fileId]) =>
        showsDesktopTab(state, key, { tabId, fileId }) ? [] : [tabId]
      )
      if (opens.length === 0 && closedSince.length === 0) {
        return true
      }
      waiting.set(key, opens.length + closedSince.length)
      for (const tabId of closedSince) {
        tabs?.delete(tabId)
        closeOnServer(key, tabId)
      }
      for (const open of opens) {
        sendToServerMain(options.environmentId, key, serverEditorOpen(key, open), answer(key, open))
      }
      return false
    },
    close: () => {
      closed = true
    }
  }
}

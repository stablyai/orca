import * as z from 'zod'
import { isTerminalLeafId } from '../../workspace-layout/stable-pane-id'
import { EditorFileRecord, EditorViewRecord } from './workspace-layout-editor-file-params'
import { NewGroupSplit } from './workspace-layout-terminal-tab-params'

export function buildWorkspaceLayoutPaneCommands() {
  const workspace = z.string().min(1)
  const tabId = z.string().min(1)
  const leafId = z.string().min(1)
  const onPane = { workspace, tabId, leafId }
  const onTab = { workspace, tabId }

  /** `newLeafId`: a pane the window already split under its own id (a tab's startup splits). */
  const SplitPaneCommand = z.object({
    type: z.literal('splitPane'),
    ...onPane,
    direction: z.enum(['horizontal', 'vertical']),
    newLeafId: z.string().refine(isTerminalLeafId).optional()
  })

  /** Main marks a close as the user's; the window cannot send that mark. */
  const ClosePaneCommand = z.object({ type: z.literal('closePane'), ...onPane })

  /** A title is trimmed and non-empty; null clears it. */
  const RenamePaneCommand = z.object({
    type: z.literal('renamePane'),
    ...onPane,
    title: z.union([z.string().trim().min(1), z.null()])
  })

  const MovePaneCommand = z.object({
    type: z.literal('movePane'),
    ...onPane,
    targetLeafId: z.string().min(1),
    side: z.enum(['left', 'right', 'top', 'bottom'])
  })

  /** The pane a tab's chat view shows; null clears it. */
  const SetChatPaneCommand = z.object({
    type: z.literal('setChatPane'),
    workspace,
    tabId,
    leafId: z.union([z.string().min(1), z.null()])
  })

  const EqualizePanesCommand = z.object({
    type: z.literal('equalizePanes'),
    workspace,
    tabId
  })

  /** Within one group too: a reorder is a move to the tab's own group. */
  const MoveTabCommand = z.object({
    type: z.literal('moveTab'),
    ...onTab,
    toGroupId: z.string().min(1),
    index: z.number().int().nonnegative(),
    // Optional so an older main still takes the move; it places by `index`.
    afterTabId: z.union([z.string().min(1), z.null()]).optional(),
    isPinned: z.boolean().optional()
  })

  /** Main mints the new group's id, or moves a lone tab's group whole. */
  const SplitGroupCommand = z.object({
    type: z.literal('splitGroup'),
    ...onTab,
    besideGroupId: z.string().min(1),
    direction: z.enum(['left', 'right', 'up', 'down'])
  })

  /** Record terminal closes with the window’s reason; editor closes leave no terminal record. */
  const CloseTabsCommand = z.object({
    type: z.literal('closeTabs'),
    workspace,
    tabIds: z.tuple([z.string().min(1)]),
    recordClose: z.enum(['user', 'cleanup']).optional()
  })

  /** Use window-proposed editor IDs, rejecting collisions; placement/preview replacement follows window rules. */
  const OpenEditorTabCommand = z.object({
    type: z.literal('openEditorTab'),
    ...onTab,
    fileId: z.string().min(1),
    contentType: z.enum(['editor', 'diff', 'conflict-review', 'check-details', 'git-graph']),
    file: EditorFileRecord.optional(),
    view: EditorViewRecord.optional(),
    groupId: z.string().min(1).optional(),
    /** Where in the group a reopened tab goes back to. */
    index: z.number().int().nonnegative().optional(),
    preview: z.literal(true).optional(),
    createdAt: z.number().int().nonnegative().optional(),
    split: NewGroupSplit
  })

  /** A window's drag-out of one pane into a new tab; main mints the tab's id. */
  const MovePaneToNewTabCommand = z.object({
    type: z.literal('movePaneToNewTab'),
    ...onPane,
    groupId: z.string().min(1),
    index: z.number().int().nonnegative().optional(),
    /** The terminal the window's pane shows now, when it has one. */
    windowDetach: z.object({
      ptyId: z.string().min(1).max(512).nullable(),
      /** The pane's folder, where an unbound pane's new shell starts. */
      startupCwd: z.string().min(1).optional()
    })
  })

  const AiVaultTitle = z.object({
    agent: z.enum(['claude', 'codex']),
    sessionId: z.string(),
    title: z.string(),
    kind: z.enum(['named', 'fallback']).optional().catch(undefined)
  })

  /** A tab's rename: a title as the window stores it today; null clears it. */
  const RenameTabCommand = z.discriminatedUnion('kind', [
    z.object({
      type: z.literal('renameTab'),
      ...onTab,
      kind: z.enum(['custom', 'generated']),
      title: z.union([z.string(), z.null()]),
      expected: z
        .object({ entityId: z.string(), executionHostId: z.string(), customTitle: z.string() })
        .optional()
    }),
    z.object({
      type: z.literal('renameTab'),
      ...onTab,
      kind: z.literal('aiVault'),
      title: z.union([AiVaultTitle, z.null()])
    })
  ])

  const SetTabPropsCommand = z.object({
    type: z.literal('setTabProps'),
    ...onTab,
    color: z.union([z.string(), z.null()]).optional(),
    isPinned: z.boolean().optional(),
    viewMode: z.enum(['terminal', 'chat']).optional(),
    clearLaunchAgent: z.literal(true).optional()
  })

  return {
    SplitPaneCommand,
    ClosePaneCommand,
    RenamePaneCommand,
    EqualizePanesCommand,
    MovePaneCommand,
    SetChatPaneCommand,
    MoveTabCommand,
    SplitGroupCommand,
    CloseTabsCommand,
    RenameTabCommand,
    SetTabPropsCommand,
    MovePaneToNewTabCommand,
    OpenEditorTabCommand
  }
}

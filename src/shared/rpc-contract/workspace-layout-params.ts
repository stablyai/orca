import { z } from 'zod'
import { isTerminalLeafId } from '../stable-pane-id'
import { isValidHostTerminalTabId } from '../terminal-tab-id'
import type { TuiAgent } from '../tui-agent'
import { isTuiAgent } from '../tui-agent-config'
import { TerminalPaneLayoutNodeSchema } from './session-tabs-schemas-params'
import { TerminalOrphanGroupLayout } from './terminal-orphan-params'
import { SleepCommand, WakeCommand } from './workspace-layout-sleep-wake-params'

export const LayoutSubscribeParams = z
  .object({
    /** Workspace keys to receive; every workspace when absent or 'all'. */
    workspaces: z.union([z.literal('all'), z.array(z.string().min(1))]).optional()
  })
  .nullish()

export const LayoutUnsubscribeParams = z.object({
  subscriptionId: z.string().min(1, 'Missing subscriptionId')
})

const OnPane = {
  workspace: z.string().min(1),
  tabId: z.string().min(1),
  leafId: z.string().min(1)
}

/** `newLeafId`: a pane the window already split under its own id (a tab's startup splits). */
const SplitPaneCommand = z.object({
  type: z.literal('splitPane'),
  ...OnPane,
  direction: z.enum(['horizontal', 'vertical']),
  newLeafId: z.string().refine(isTerminalLeafId).optional()
})

/** Main marks a close as the user's; the window cannot send that mark. `automatic`: not the
 *  user's close (the pane's terminal ended), so no launch in it was stopped by the user. */
const ClosePaneCommand = z.object({
  type: z.literal('closePane'),
  ...OnPane,
  automatic: z.literal(true).optional()
})

/** A title is trimmed and non-empty; null clears it. */
const RenamePaneCommand = z.object({
  type: z.literal('renamePane'),
  ...OnPane,
  title: z.union([z.string().trim().min(1), z.null()])
})

const MovePaneCommand = z.object({
  type: z.literal('movePane'),
  ...OnPane,
  targetLeafId: z.string().min(1),
  side: z.enum(['left', 'right', 'top', 'bottom'])
})

/** The tab's tree with its new ratios; main refuses one whose panes differ from its own. */
const SetPaneRatiosCommand = z.object({
  type: z.literal('setPaneRatios'),
  workspace: OnPane.workspace,
  tabId: OnPane.tabId,
  root: TerminalPaneLayoutNodeSchema
})

/** The pane a tab's chat view shows; null clears it. */
const SetChatPaneCommand = z.object({
  type: z.literal('setChatPane'),
  workspace: OnPane.workspace,
  tabId: OnPane.tabId,
  leafId: z.union([z.string().min(1), z.null()])
})

const EqualizePanesCommand = z.object({
  type: z.literal('equalizePanes'),
  workspace: OnPane.workspace,
  tabId: OnPane.tabId
})

const OnTab = { workspace: OnPane.workspace, tabId: OnPane.tabId }

/** Within one group too: a reorder is a move to the tab's own group. */
const MoveTabCommand = z.object({
  type: z.literal('moveTab'),
  ...OnTab,
  toGroupId: z.string().min(1),
  index: z.number().int().nonnegative()
})

/** Main mints the new group's id, or moves a lone tab's group whole. */
const SplitGroupCommand = z.object({
  type: z.literal('splitGroup'),
  ...OnTab,
  besideGroupId: z.string().min(1),
  direction: z.enum(['left', 'right', 'up', 'down'])
})

/** The workspace's group tree with its new ratios; main refuses one whose groups differ. */
const SetGroupRatiosCommand = z.object({
  type: z.literal('setGroupRatios'),
  workspace: OnPane.workspace,
  groupLayout: TerminalOrphanGroupLayout
})

/**
 * The window's close of one tab it already closed; main records a terminal's close with the
 * window's reason. An editor tab's close records nothing.
 */
const CloseTabsCommand = z.object({
  type: z.literal('closeTabs'),
  workspace: OnPane.workspace,
  tabIds: z.tuple([z.string().min(1)]),
  recordClose: z.enum(['user', 'cleanup']).optional()
})

/** An open into a new group, named by the command's groupId, beside this one (NewGroupSplit). */
const NewGroupSplit = z
  .object({
    besideGroupId: z.string().min(1),
    besideLastGroupId: z.string().min(1).optional(),
    direction: z.enum(['left', 'right', 'up', 'down'])
  })
  .optional()

/** An edit-mode file's restorable record, as the window saves it. */
const EditorFileRecord = z.object({
  filePath: z.string().min(1),
  relativePath: z.string(),
  language: z.string(),
  runtimeEnvironmentId: z.string().nullable().optional(),
  externalSshTargetId: z.string().min(1).optional(),
  readOnly: z.literal(true).optional(),
  liveTail: z.literal(true).optional()
})

/**
 * An editor tab under the id the window drew it with: its callers act on the tab at once. Main
 * places it and replaces the group's preview by the same rules as the window.
 */
const OpenEditorTabCommand = z.object({
  type: z.literal('openEditorTab'),
  ...OnTab,
  fileId: z.string().min(1),
  contentType: z.enum(['editor', 'diff', 'conflict-review', 'check-details']),
  file: EditorFileRecord.optional(),
  groupId: z.string().min(1).optional(),
  preview: z.literal(true).optional(),
  createdAt: z.number().int().nonnegative().optional(),
  split: NewGroupSplit
})

/** A window's drag-out of one pane into a new tab; main mints the tab's id. */
const MovePaneToNewTabCommand = z.object({
  type: z.literal('movePaneToNewTab'),
  ...OnPane,
  groupId: z.string().min(1),
  index: z.number().int().nonnegative().optional(),
  /** The terminal the window's pane shows now, when it has one. */
  windowDetach: z.object({ ptyId: z.string().min(1).max(512).nullable() })
})

/**
 * A terminal tab under the ids the window drew it with: its callers and the pane's terminal need
 * them at once. Main refuses an id another tab holds; the same create again changes nothing.
 */
const CreateTerminalTabCommand = z.object({
  type: z.literal('createTerminalTab'),
  workspace: OnPane.workspace,
  tabId: z.string().refine(isValidHostTerminalTabId),
  leafId: z.string().refine(isTerminalLeafId),
  groupId: z.string().min(1).optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  createdAt: z.number().int().nonnegative().optional(),
  quickCommandLabel: z.string().trim().min(1).optional(),
  creation: z
    .object({
      defaultTitle: z.string().min(1).optional(),
      shellOverride: z.string().min(1).optional(),
      startupCwd: z.string().min(1).optional(),
      forceHostRuntime: z.literal(true).optional(),
      launchAgent: z
        .custom<TuiAgent>((value) => typeof value === 'string' && isTuiAgent(value))
        .optional()
    })
    .optional(),
  /** Only into a workspace with no tab in main's copy; otherwise nothing is created. */
  initial: z.literal('activation').optional(),
  /** A live terminal no pane shows: its pane when main holds one, else this tab, bound to it. */
  adopt: z
    .object({ ptyId: z.string().min(1), recordedPaneKey: z.string().min(1).optional() })
    .optional(),
  split: NewGroupSplit
})

const AiVaultTitle = z.object({
  agent: z.enum(['claude', 'codex']),
  sessionId: z.string(),
  title: z.string()
})

/** A tab's rename: a title as the window stores it today; null clears it. */
const RenameTabCommand = z.discriminatedUnion('kind', [
  z.object({
    type: z.literal('renameTab'),
    ...OnTab,
    kind: z.enum(['custom', 'generated']),
    title: z.union([z.string(), z.null()])
  }),
  z.object({
    type: z.literal('renameTab'),
    ...OnTab,
    kind: z.literal('aiVault'),
    title: z.union([AiVaultTitle, z.null()])
  })
])

const SetTabPropsCommand = z.object({
  type: z.literal('setTabProps'),
  ...OnTab,
  color: z.union([z.string(), z.null()]).optional(),
  isPinned: z.boolean().optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  clearLaunchAgent: z.literal(true).optional()
})

/**
 * A browser tab under the ids the window drew it with: its pages and the tab's own callers need
 * them at once. Main refuses an id another tab or page holds; the same open again changes nothing.
 */
const OpenBrowserTabCommand = z.object({
  type: z.literal('openBrowserTab'),
  workspace: OnPane.workspace,
  tabId: z.string().min(1),
  browserTabId: z.string().min(1),
  pageId: z.string().min(1),
  profileId: z.string().min(1).nullable().optional(),
  sessionPartition: z.string().min(1).nullable().optional(),
  groupId: z.string().min(1).optional(),
  afterTabId: z.string().min(1).optional(),
  index: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  browserCreatedAt: z.number().int().nonnegative().optional(),
  split: NewGroupSplit
})

/**
 * A chat tab under the id the window drew it with: status and attention address it at once. The
 * same open again changes nothing; an id another tab holds is refused.
 */
const OpenAgentSessionTabCommand = z.object({
  type: z.literal('openAgentSessionTab'),
  ...OnTab,
  sessionId: z.string().min(1),
  agent: z.string().min(1),
  groupId: z.string().min(1).optional(),
  afterTabId: z.string().min(1).optional(),
  index: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  split: NewGroupSplit
})

const OnBrowserPage = {
  workspace: OnPane.workspace,
  browserTabId: z.string().min(1),
  pageId: z.string().min(1)
}

/** A page the window added to a browser tab, under its own id. */
const OpenBrowserPageCommand = z.object({ type: z.literal('openBrowserPage'), ...OnBrowserPage })

const CloseBrowserPageCommand = z.object({ type: z.literal('closeBrowserPage'), ...OnBrowserPage })

/** A converted page: the window's new page takes the old one's place. */
const ReplaceBrowserPageCommand = z.object({
  type: z.literal('replaceBrowserPage'),
  ...OnBrowserPage,
  newPageId: z.string().min(1)
})

const SetBrowserTabProfileCommand = z.object({
  type: z.literal('setBrowserTabProfile'),
  workspace: OnPane.workspace,
  browserTabId: z.string().min(1),
  profileId: z.string().min(1).nullable(),
  sessionPartition: z.string().min(1).nullable()
})

const PromotePreviewTabCommand = z.object({ type: z.literal('promotePreviewTab'), ...OnTab })

/** The window applied the workspace's default tabs (or it had none); main records it, once. */
const SetDefaultTabsAppliedCommand = z.object({
  type: z.literal('setDefaultTabsApplied'),
  workspace: OnPane.workspace
})

/** A simulator tab under the id the window drew it with, which is also its entity. */
const OpenSimulatorTabCommand = z.object({
  type: z.literal('openSimulatorTab'),
  ...OnTab,
  groupId: z.string().min(1).optional(),
  afterTabId: z.string().min(1).optional(),
  index: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  split: NewGroupSplit
})

/**
 * Restored editor tabs the window moved to the workspace that owns their file (F42): the window
 * resolved that owner. Main refuses it when the two workspaces are in different partitions.
 */
const MoveTabToWorkspaceCommand = z.object({
  type: z.literal('moveTabToWorkspace'),
  workspace: OnPane.workspace,
  toWorkspace: z.string().min(1),
  tabs: z
    .array(
      z.object({
        tabId: z.string().min(1),
        newTabId: z.string().min(1),
        newEntityId: z.string().min(1)
      })
    )
    .min(1),
  groupId: z.string().min(1),
  file: EditorFileRecord.optional()
})

/**
 * Open files the window renamed or moved on disk, under the ids the window gave them; an edit-mode
 * file's record moves from its old path.
 */
const RenameEditorFilesCommand = z.object({
  type: z.literal('renameEditorFiles'),
  workspace: OnPane.workspace,
  renames: z
    .array(
      z.object({
        fileId: z.string().min(1),
        newFileId: z.string().min(1),
        record: z.object({ fromFilePath: z.string().min(1), file: EditorFileRecord }).optional()
      })
    )
    .min(1)
})

/**
 * A window's layout command (`layout.apply`, registered only in a layout-owner build). The window
 * names what it acts on; main mints every new id but a created terminal tab's
 * (see CreateTerminalTabCommand), a browser tab's and page's, which the window already shows
 * (see OpenBrowserTabCommand), an editor tab's (see OpenEditorTabCommand), a chat tab's (see
 * OpenAgentSessionTabCommand), a simulator tab's (see OpenSimulatorTabCommand), and the group an
 * open into a new split makes (see NewGroupSplit).
 */
export const LayoutApplyParams = z.object({
  command: z.discriminatedUnion('type', [
    CreateTerminalTabCommand,
    SplitPaneCommand,
    ClosePaneCommand,
    RenamePaneCommand,
    EqualizePanesCommand,
    MovePaneCommand,
    SetPaneRatiosCommand,
    SetChatPaneCommand,
    MoveTabCommand,
    SplitGroupCommand,
    SetGroupRatiosCommand,
    CloseTabsCommand,
    RenameTabCommand,
    SetTabPropsCommand,
    MovePaneToNewTabCommand,
    OpenBrowserTabCommand,
    OpenBrowserPageCommand,
    CloseBrowserPageCommand,
    ReplaceBrowserPageCommand,
    SetBrowserTabProfileCommand,
    OpenEditorTabCommand,
    OpenAgentSessionTabCommand,
    PromotePreviewTabCommand,
    OpenSimulatorTabCommand,
    MoveTabToWorkspaceCommand,
    RenameEditorFilesCommand,
    SleepCommand,
    WakeCommand,
    SetDefaultTabsAppliedCommand
  ])
})

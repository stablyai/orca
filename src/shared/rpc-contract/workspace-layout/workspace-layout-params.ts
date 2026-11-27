import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { SleepCommand, StartPaneCommand, WakeCommand } from './workspace-layout-sleep-wake-params'
import { RenameTabsCommand } from './workspace-layout-rename-tabs-params'
import { EditorFileRecord, EditorViewRecord } from './workspace-layout-editor-file-params'
import { SetGroupRatiosCommand, SetPaneRatiosCommand } from './workspace-layout-ratio-params'
import {
  ApplyDefaultTabsCommand,
  CreateTerminalTabCommand,
  NewGroupSplit
} from './workspace-layout-terminal-tab-params'
import { buildWorkspaceLayoutPaneCommands } from './workspace-layout-pane-commands'

export const LayoutSubscribeParams = lazyZodSchema(() =>
  z
    .object({
      /** Workspace keys to receive; every workspace when absent or 'all'. */
      workspaces: z.union([z.literal('all'), z.array(z.string().min(1))]).optional()
    })
    .nullish()
)

export const LayoutUnsubscribeParams = lazyZodSchema(() =>
  z.object({
    subscriptionId: z.string().min(1, 'Missing subscriptionId')
  })
)

/** A paired desktop's view of the server's workspaces: each one's shown group, null for none. */
export const LayoutReportViewParams = lazyZodSchema(() =>
  z.object({
    activeGroupByWorkspace: z.record(z.string().min(1), z.string().min(1).nullable()),
    /** A re-send after a reconnect, not a change the user made: it never outranks a live report. */
    refresh: z.literal(true).optional()
  })
)

function buildWorkspaceLayoutApplySchema() {
  const workspace = z.string().min(1)
  const tabId = z.string().min(1)
  const onTab = { workspace, tabId }
  const onBrowserPage = {
    workspace,
    browserTabId: z.string().min(1),
    pageId: z.string().min(1)
  }

  /** Preserve window-created browser tab/page IDs for immediate callers; refuse collisions and replay opens idempotently. */
  const OpenBrowserTabCommand = z.object({
    type: z.literal('openBrowserTab'),
    workspace,
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

  /** Preserve window chat IDs for status/attention; refuse collisions and replay opens idempotently. */
  const OpenAgentSessionTabCommand = z.object({
    type: z.literal('openAgentSessionTab'),
    ...onTab,
    sessionId: z.string().min(1),
    agent: z.string().min(1),
    groupId: z.string().min(1).optional(),
    afterTabId: z.string().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
    createdAt: z.number().int().nonnegative().optional(),
    split: NewGroupSplit
  })

  /** A bot group's room tab; its entity is the group id. */
  const OpenRoomTabCommand = z.object({
    type: z.literal('openRoomTab'),
    ...onTab,
    botGroupId: z.string().min(1),
    groupId: z.string().min(1).optional(),
    afterTabId: z.string().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
    createdAt: z.number().int().nonnegative().optional(),
    split: NewGroupSplit
  })

  /** A page the window added to a browser tab, under its own id. */
  const OpenBrowserPageCommand = z.object({ type: z.literal('openBrowserPage'), ...onBrowserPage })
  const CloseBrowserPageCommand = z.object({
    type: z.literal('closeBrowserPage'),
    ...onBrowserPage
  })

  /** A converted page replaces the rendered resource without moving its tab-bar slot. */
  const ReplaceTabContentCommand = z.object({
    type: z.literal('replaceTabContent'),
    workspace,
    replacement: z.object({
      kind: z.literal('browser-page'),
      browserTabId: z.string().min(1),
      pageId: z.string().min(1),
      newPageId: z.string().min(1)
    })
  })

  const SetBrowserTabProfileCommand = z.object({
    type: z.literal('setBrowserTabProfile'),
    workspace,
    browserTabId: z.string().min(1),
    profileId: z.string().min(1).nullable(),
    sessionPartition: z.string().min(1).nullable()
  })

  const PromotePreviewTabCommand = z.object({ type: z.literal('promotePreviewTab'), ...onTab })

  /** The window applied the workspace's default tabs (or it had none); main records it, once. */
  const SetDefaultTabsAppliedCommand = z.object({
    type: z.literal('setDefaultTabsApplied'),
    workspace
  })

  /** A simulator tab under the id the window drew it with, which is also its entity. */
  const OpenSimulatorTabCommand = z.object({
    type: z.literal('openSimulatorTab'),
    ...onTab,
    groupId: z.string().min(1).optional(),
    afterTabId: z.string().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
    createdAt: z.number().int().nonnegative().optional(),
    split: NewGroupSplit
  })

  /** Move restored editor tabs to the window-resolved owning workspace, preserving proposed IDs (F42). */
  const MoveTabToWorkspaceCommand = z.object({
    type: z.literal('moveTabToWorkspace'),
    workspace,
    toWorkspace: z.string().min(1),
    tabs: z
      .array(
        z.object({
          tabId: z.string().min(1),
          newTabId: z.string().min(1),
          newEntityId: z.string().min(1),
          view: EditorViewRecord.optional()
        })
      )
      .min(1),
    groupId: z.string().min(1),
    file: EditorFileRecord.optional()
  })

  /** Apply disk renames to window-proposed editor IDs: move edit records and update non-plain tab view paths. */
  const EditorFileRenames = z
    .array(
      z.object({
        fileId: z.string().min(1),
        newFileId: z.string().min(1),
        record: z.object({ fromFilePath: z.string().min(1), file: EditorFileRecord }).optional(),
        view: EditorViewRecord.optional()
      })
    )
    .min(1)

  const RenameEditorFilesCommand = z.object({
    type: z.literal('renameEditorFiles'),
    workspace,
    renames: EditorFileRenames,
    /** Other workspaces' renames of the same disk move: all are applied, or none. */
    alsoIn: z
      .array(z.object({ workspace, renames: EditorFileRenames }))
      .min(1)
      .optional()
  })

  const pane = buildWorkspaceLayoutPaneCommands()

  return z.object({
    command: z.discriminatedUnion('type', [
      CreateTerminalTabCommand,
      pane.SplitPaneCommand,
      pane.ClosePaneCommand,
      pane.RenamePaneCommand,
      pane.EqualizePanesCommand,
      pane.MovePaneCommand,
      SetPaneRatiosCommand,
      pane.SetChatPaneCommand,
      pane.MoveTabCommand,
      pane.SplitGroupCommand,
      SetGroupRatiosCommand,
      pane.CloseTabsCommand,
      pane.RenameTabCommand,
      RenameTabsCommand,
      pane.SetTabPropsCommand,
      pane.MovePaneToNewTabCommand,
      OpenBrowserTabCommand,
      OpenBrowserPageCommand,
      CloseBrowserPageCommand,
      ReplaceTabContentCommand,
      SetBrowserTabProfileCommand,
      pane.OpenEditorTabCommand,
      OpenAgentSessionTabCommand,
      PromotePreviewTabCommand,
      OpenSimulatorTabCommand,
      OpenRoomTabCommand,
      MoveTabToWorkspaceCommand,
      RenameEditorFilesCommand,
      SleepCommand,
      WakeCommand,
      StartPaneCommand,
      SetDefaultTabsAppliedCommand,
      ApplyDefaultTabsCommand
    ])
  })
}

/** Layout-owner command: main mints IDs except window-proposed terminal/browser/editor/chat/simulator tabs,
 * browser pages and groups created by NewGroupSplit. */
export const LayoutApplyParams = lazyZodSchema(buildWorkspaceLayoutApplySchema)

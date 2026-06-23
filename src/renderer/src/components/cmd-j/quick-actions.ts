import { FileText, FolderPlus, Globe, Play, SquareTerminal, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CmdJQuickActionAvailability, CmdJQuickActionContext } from './quick-action-context'
import {
  getCurrentWorkspaceActionAvailability,
  getWorkspaceScopedActionAvailability
} from './quick-action-context'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export type CmdJQuickActionRunResult =
  | { status: 'ok' }
  | {
      status: 'unavailable'
      reason: Exclude<CmdJQuickActionAvailability, { available: true }>['reason']
    }

export type CmdJQuickAction = {
  id: string
  kind: 'action'
  title: string
  description: string
  icon: LucideIcon
  verbKeywords: string[]
  isAvailable: (ctx: CmdJQuickActionContext) => CmdJQuickActionAvailability
  run: (ctx: CmdJQuickActionContext) => Promise<CmdJQuickActionRunResult>
}

export const CREATE_WORKSPACE_QUICK_ACTION_ID = 'create-workspace'

function workspaceActionAvailability(ctx: CmdJQuickActionContext): CmdJQuickActionAvailability {
  return getWorkspaceScopedActionAvailability(ctx)
}

function currentWorkspaceActionAvailability(
  ctx: CmdJQuickActionContext
): CmdJQuickActionAvailability {
  return getCurrentWorkspaceActionAvailability(ctx)
}

async function runWorkspaceAction(
  ctx: CmdJQuickActionContext,
  run: (groupId: string) => Promise<void>
): Promise<CmdJQuickActionRunResult> {
  const availability = workspaceActionAvailability(ctx)
  if (!availability.available) {
    return { status: 'unavailable', reason: availability.reason }
  }
  if (!ctx.activeGroupId) {
    return { status: 'unavailable', reason: 'no-active-group' }
  }
  await run(ctx.activeGroupId)
  return { status: 'ok' }
}

// Why: Cmd+J actions are for high-frequency, safe, context-light verbs.
// Context-heavy setup flows such as Ghostty import and browser cookie import
// stay inside their Settings panes where explanatory UI and failure states fit.
export const getCmdJQuickActions = createLocalizedCatalog((): CmdJQuickAction[] => [
  {
    id: 'new-browser-tab',
    kind: 'action',
    title: translate('auto.components.cmd.j.quick.actions.892bfa9339', 'New Browser Tab'),
    description: translate(
      'auto.components.cmd.j.quick.actions.784812ca24',
      'Open a browser tab in the active workspace.'
    ),
    icon: Globe,
    verbKeywords: [
      translate('auto.components.cmd.j.quick.actions.verbs.newBrowser', 'new browser'),
      translate('auto.components.cmd.j.quick.actions.verbs.newBrowserTab', 'new browser tab'),
      translate('auto.components.cmd.j.quick.actions.verbs.openBrowser', 'open browser'),
      translate('auto.components.cmd.j.quick.actions.verbs.browserTab', 'browser tab')
    ],
    isAvailable: workspaceActionAvailability,
    run: (ctx) => runWorkspaceAction(ctx, ctx.openNewBrowserTab)
  },
  {
    id: 'new-markdown-file',
    kind: 'action',
    title: translate('auto.components.cmd.j.quick.actions.25349b66fc', 'New Markdown File'),
    description: translate(
      'auto.components.cmd.j.quick.actions.f2a1b33f8d',
      'Create an untitled markdown file in the active workspace.'
    ),
    icon: FileText,
    verbKeywords: [
      translate('auto.components.cmd.j.quick.actions.verbs.newMarkdown', 'new markdown'),
      translate('auto.components.cmd.j.quick.actions.verbs.newMarkdownFile', 'new markdown file'),
      translate('auto.components.cmd.j.quick.actions.verbs.newMark', 'new mark'),
      translate('auto.components.cmd.j.quick.actions.verbs.newFile', 'new file'),
      translate('auto.components.cmd.j.quick.actions.verbs.markdownFile', 'markdown file')
    ],
    isAvailable: workspaceActionAvailability,
    run: (ctx) => runWorkspaceAction(ctx, ctx.openNewMarkdownFile)
  },
  {
    id: 'new-terminal-tab',
    kind: 'action',
    title: translate('auto.components.cmd.j.quick.actions.34980395d4', 'New Terminal Tab'),
    description: translate(
      'auto.components.cmd.j.quick.actions.f70812764a',
      'Open a terminal tab in the active workspace.'
    ),
    icon: SquareTerminal,
    verbKeywords: [
      translate('auto.components.cmd.j.quick.actions.verbs.newTerminal', 'new terminal'),
      translate('auto.components.cmd.j.quick.actions.verbs.newTerminalTab', 'new terminal tab'),
      translate('auto.components.cmd.j.quick.actions.verbs.newShell', 'new shell'),
      translate('auto.components.cmd.j.quick.actions.verbs.terminalTab', 'terminal tab')
    ],
    isAvailable: workspaceActionAvailability,
    run: (ctx) => runWorkspaceAction(ctx, ctx.openNewTerminalTab)
  },
  {
    id: CREATE_WORKSPACE_QUICK_ACTION_ID,
    kind: 'action',
    title: translate('auto.components.cmd.j.quick.actions.52ac9da671', 'Create Worktree'),
    description: translate(
      'auto.components.cmd.j.quick.actions.0b1f25f796',
      'Start a new worktree.'
    ),
    icon: FolderPlus,
    verbKeywords: [
      translate('auto.components.cmd.j.quick.actions.verbs.createWorktree', 'create worktree'),
      translate('auto.components.cmd.j.quick.actions.verbs.addWorktree', 'add worktree'),
      translate('auto.components.cmd.j.quick.actions.verbs.newWorktree', 'new worktree')
    ],
    isAvailable: () => ({ available: true }),
    run: async (ctx) => {
      ctx.openCreateWorkspace()
      return { status: 'ok' }
    }
  },
  {
    id: 'delete-workspace',
    kind: 'action',
    title: translate('auto.components.cmd.j.quick.actions.9537b910fe', 'Delete Worktree'),
    description: translate(
      'auto.components.cmd.j.quick.actions.54853d52a2',
      'Delete the current worktree.'
    ),
    icon: Trash2,
    verbKeywords: [
      translate('auto.components.cmd.j.quick.actions.verbs.deleteWorktree', 'delete worktree'),
      translate(
        'auto.components.cmd.j.quick.actions.verbs.deleteCurrentWorktree',
        'delete current worktree'
      ),
      translate('auto.components.cmd.j.quick.actions.verbs.removeWorktree', 'remove worktree'),
      translate('auto.components.cmd.j.quick.actions.verbs.trashWorktree', 'trash worktree')
    ],
    isAvailable: currentWorkspaceActionAvailability,
    run: async (ctx) => {
      const availability = currentWorkspaceActionAvailability(ctx)
      if (!availability.available) {
        return { status: 'unavailable', reason: availability.reason }
      }
      ctx.deleteActiveWorkspace()
      return { status: 'ok' }
    }
  },
  {
    id: 'add-quick-command',
    kind: 'action',
    title: translate('auto.components.cmd.j.quick.actions.a43ab56fc1', 'Add Quick Command'),
    description: translate(
      'auto.components.cmd.j.quick.actions.c884a6398e',
      'Create a saved terminal command.'
    ),
    icon: Play,
    verbKeywords: [
      translate('auto.components.cmd.j.quick.actions.verbs.addQuickCommand', 'add quick command'),
      translate('auto.components.cmd.j.quick.actions.verbs.newQuickCommand', 'new quick command')
    ],
    isAvailable: () => ({ available: true }),
    run: async (ctx) => {
      ctx.openAddQuickCommand()
      return { status: 'ok' }
    }
  }
])

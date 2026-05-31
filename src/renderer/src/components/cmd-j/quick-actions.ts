import { FileText, FolderPlus, Globe, Play, SquareTerminal, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CmdJQuickActionAvailability, CmdJQuickActionContext } from './quick-action-context'
import {
  getCurrentWorkspaceActionAvailability,
  getWorkspaceScopedActionAvailability
} from './quick-action-context'

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
export const CMD_J_QUICK_ACTIONS: readonly CmdJQuickAction[] = [
  {
    id: 'new-browser-tab',
    kind: 'action',
    title: 'New Browser Tab',
    description: 'Open a browser tab in the active workspace.',
    icon: Globe,
    verbKeywords: ['new browser', 'new browser tab', 'open browser', 'browser tab'],
    isAvailable: workspaceActionAvailability,
    run: (ctx) => runWorkspaceAction(ctx, ctx.openNewBrowserTab)
  },
  {
    id: 'new-markdown-file',
    kind: 'action',
    title: 'New Markdown File',
    description: 'Create an untitled markdown file in the active workspace.',
    icon: FileText,
    verbKeywords: ['new markdown', 'new markdown file', 'new mark', 'new file', 'markdown file'],
    isAvailable: workspaceActionAvailability,
    run: (ctx) => runWorkspaceAction(ctx, ctx.openNewMarkdownFile)
  },
  {
    id: 'new-terminal-tab',
    kind: 'action',
    title: 'New Terminal Tab',
    description: 'Open a terminal tab in the active workspace.',
    icon: SquareTerminal,
    verbKeywords: ['new terminal', 'new terminal tab', 'new shell', 'terminal tab'],
    isAvailable: workspaceActionAvailability,
    run: (ctx) => runWorkspaceAction(ctx, ctx.openNewTerminalTab)
  },
  {
    id: 'create-workspace',
    kind: 'action',
    title: 'Create Workspace',
    description: 'Start a new workspace.',
    icon: FolderPlus,
    verbKeywords: ['create workspace', 'add workspace', 'new workspace'],
    isAvailable: () => ({ available: true }),
    run: async (ctx) => {
      ctx.openCreateWorkspace()
      return { status: 'ok' }
    }
  },
  {
    id: 'delete-workspace',
    kind: 'action',
    title: 'Delete Workspace',
    description: 'Delete the current workspace.',
    icon: Trash2,
    verbKeywords: [
      'delete workspace',
      'delete current workspace',
      'delete worktree',
      'remove workspace',
      'remove worktree',
      'trash workspace'
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
    title: 'Add Quick Command',
    description: 'Create a saved terminal command.',
    icon: Play,
    verbKeywords: ['add quick command', 'new quick command'],
    isAvailable: () => ({ available: true }),
    run: async (ctx) => {
      ctx.openAddQuickCommand()
      return { status: 'ok' }
    }
  }
]

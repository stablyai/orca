import React from 'react'
import { Archive, Copy, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { archiveZotzConversation } from './zotz-archive'
import { runWorktreeDelete } from '../../sidebar/workspace-actions/deletion/delete-worktree-flow'
import type { Worktree } from '../../../../../shared/worktree/types'

type MenuAction = {
  key: string
  label: string
  icon: LucideIcon
  destructive?: boolean
  separatorBefore?: boolean
  run: () => void
}

function conversationActions(worktree: Worktree, t: Translate): MenuAction[] {
  const { openModal } = useAppStore.getState()
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  const actions: MenuAction[] = [
    {
      key: 'rename',
      label: t('zotz.sidebar.rename', 'Rename'),
      icon: Pencil,
      run: () =>
        openModal('edit-meta', {
          worktreeId: worktree.id,
          repoId: worktree.repoId,
          executionHostId: worktree.hostId,
          currentDisplayName: worktree.displayName,
          currentComment: worktree.comment,
          focus: 'displayName'
        })
    }
  ]
  if (branch) {
    actions.push({
      key: 'duplicate',
      label: t('zotz.sidebar.duplicate', 'Duplicate in a new worktree'),
      icon: Copy,
      run: () =>
        openModal('new-workspace-composer', {
          initialRepoId: worktree.repoId,
          initialBaseBranch: branch,
          telemetrySource: 'sidebar'
        })
    })
  }
  actions.push({
    key: 'archive',
    label: t('zotz.sidebar.archive', 'Archive'),
    icon: Archive,
    separatorBefore: true,
    run: () => void archiveZotzConversation(worktree)
  })
  // The project's own checkout can be archived but never deleted; only its worktrees can.
  if (!worktree.isMainWorktree) {
    actions.push({
      key: 'delete',
      label: t('zotz.sidebar.delete', 'Delete'),
      icon: Trash2,
      destructive: true,
      run: () =>
        runWorktreeDelete(worktree.id, {
          expectedInstanceId: worktree.instanceId,
          ...(worktree.hostId ? { expectedHostId: worktree.hostId } : {})
        })
    })
  }
  return actions
}

/** Right-click and "…" menu for a conversation row: rename, duplicate, archive, delete. */
export function ZotzConversationMenu({
  worktree,
  children
}: {
  worktree: Worktree | null
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  if (!worktree) {
    return <>{children}</>
  }
  const actions = conversationActions(worktree, t)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group/conversation relative">
          {children}
          <div className="absolute top-1.5 right-1 opacity-0 transition-opacity group-hover/conversation:opacity-100 has-[[data-state=open]]:opacity-100">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label={t('zotz.sidebar.conversationActions', 'Conversation actions')}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom">
                {actions.map((action) => (
                  <React.Fragment key={action.key}>
                    {action.separatorBefore ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem
                      variant={action.destructive ? 'destructive' : 'default'}
                      onSelect={action.run}
                    >
                      <action.icon className="size-4" />
                      {action.label}
                    </DropdownMenuItem>
                  </React.Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((action) => (
          <React.Fragment key={action.key}>
            {action.separatorBefore ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              variant={action.destructive ? 'destructive' : 'default'}
              onSelect={action.run}
            >
              <action.icon className="size-4" />
              {action.label}
            </ContextMenuItem>
          </React.Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

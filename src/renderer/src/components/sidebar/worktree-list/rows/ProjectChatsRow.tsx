import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useRepoSshGate } from '@/lib/workspace/catalog/use-repo-ssh-gate'
import WorktreeCardAgents from '../../workspace-card/activity/WorktreeCardAgents'
import { useAgentPresentation } from '../../workspace-card/activity/useWorktreeAgentRows'
import { useHostRootKeys } from '../../workspace-card/activity/use-worktree-agent-host-roots'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import type { ProjectChatsRow } from '../../../../../../shared/sidebar-list/row-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getTreeLane } from './project-frame'
import { startGroupChat, startProjectChat } from './start-chat'
import { getRepoHeaderCreateState } from './repo-header-create-state'
import type { RepoHeaderProjectActions } from './repo-header-project-actions'

function SectionLabel({
  label,
  children
}: {
  label: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-6 items-center text-[11px] font-medium text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </div>
  )
}

function TextAction({
  label,
  disabled,
  title,
  onAction
}: {
  label: string
  disabled?: boolean
  title?: string
  onAction: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="muted-field-icon"
      size="xs"
      disabled={disabled}
      title={title}
      onClick={onAction}
    >
      {label}
    </Button>
  )
}

/** The open project's closing line: "+ chat" and, for git projects, "+ worktree". */
function ProjectActions({
  row,
  onCreateForRepo
}: {
  row: Exclude<ProjectChatsRow, { section: 'group-chats' }>
  onCreateForRepo: RepoHeaderProjectActions['onCreateForRepo']
}): React.JSX.Element {
  const t = useTranslate()
  const sshGate = useRepoSshGate(row.repo)
  const createState = getRepoHeaderCreateState(
    { repo: row.repo, label: row.repo.displayName, sshGate },
    t
  )
  const create = (): void => onCreateForRepo(row.repo, { pinHost: row.pinHost })
  const main = row.mainWorktree
  return (
    // Pulled back by the buttons' own padding so their text starts on the lane.
    <div className="-ms-2 flex h-6 items-center gap-1">
      <TextAction
        label={t('components.sidebar.projectChats.addChat', '+ chat')}
        // A folder project has no main checkout to chat in; its new workspace is its new chat.
        onAction={main ? () => startProjectChat(main) : create}
        disabled={!main && createState.disabled}
      />
      {isGitRepoKind(row.repo) ? (
        <TextAction
          label={t('components.sidebar.projectChats.addWorktree', '+ worktree')}
          disabled={createState.disabled}
          title={createState.tooltip}
          onAction={create}
        />
      ) : null}
    </div>
  )
}

function ChatsList({ mainWorktree }: { mainWorktree: Worktree }): React.JSX.Element {
  const t = useTranslate()
  const allRoots = useAgentPresentation(
    `roots\0${mainWorktree.id}`,
    useCallback((p) => p.display.roots(mainWorktree.id), [mainWorktree.id])
  )
  const roots = useHostRootKeys(mainWorktree.id, mainWorktree.hostId, allRoots)
  return (
    <>
      <SectionLabel label={t('components.sidebar.projectChats.title', 'Chats')} />
      {roots.length > 0 ? (
        // Agent rows inset their glyph 4px; pulling back keeps it on the lane.
        <div className="-ms-1">
          <WorktreeCardAgents
            worktreeId={mainWorktree.id}
            executionHostId={mainWorktree.hostId}
            expandAll
          />
        </div>
      ) : null}
    </>
  )
}

/** One Tree card style section line: a project's Chats, Worktrees label or actions, or a folder group's Chats label. */
export const ProjectChatsLine = React.memo(function ProjectChatsLine({
  row,
  onCreateForRepo,
  onCreateFolderWorkspace
}: {
  row: ProjectChatsRow
  onCreateForRepo: RepoHeaderProjectActions['onCreateForRepo']
  onCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
}): React.JSX.Element {
  const t = useTranslate()
  // Memoized: subscribe so a language change still repaints its labels.
  useTranslation()
  // A folder group's chats are a card one level in from the group.
  const lane = getTreeLane('card', row.groupDepth + (row.section === 'group-chats' ? 1 : 0))
  return (
    <div
      // The group chats label opens its own card, so it needs a header's room above it.
      className={row.section === 'group-chats' ? 'pt-1 pb-0.5' : 'pb-0.5'}
      style={{ paddingInlineStart: lane.glyph, paddingInlineEnd: lane.right }}
      data-project-chats={row.section === 'chats' ? row.repo.id : undefined}
    >
      {row.section === 'chats' && row.mainWorktree ? (
        <ChatsList mainWorktree={row.mainWorktree} />
      ) : row.section === 'worktrees' ? (
        <SectionLabel label={t('components.sidebar.projectChats.worktrees', 'Worktrees')} />
      ) : row.section === 'actions' ? (
        <ProjectActions row={row} onCreateForRepo={onCreateForRepo} />
      ) : row.section === 'group-chats' ? (
        <SectionLabel label={t('components.sidebar.projectChats.groupTitle', 'Group chats')}>
          <TextAction
            label={t('components.sidebar.projectChats.addChat', '+ chat')}
            onAction={() => void startGroupChat(row.projectGroup, onCreateFolderWorkspace)}
          />
        </SectionLabel>
      ) : null}
    </div>
  )
})

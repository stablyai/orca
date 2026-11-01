import { useMemo, useState, useRef, useImperativeHandle, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ChevronDown, ArrowUp, ArrowDown } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { getRepoExecutionHostId, type ExecutionHostScope } from '../../../../shared/execution-host'
import { getManualRepoOrder } from '../../../../shared/manual-repo-order'
import { useRepos, useAllWorktrees, useProjectHostSetupProjection } from '@/store/selectors'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { ConversationProjectMenu } from './ConversationProjectMenu'
import { HiddenConversationProjects } from './HiddenConversationProjects'
import type { AiVaultSessionVirtualList } from '../right-sidebar/AiVaultSessionVirtualList'
import { resolveAiVaultSessionRowChatActions } from '../right-sidebar/ai-vault-session-chat-action'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSessionProject } from '../../../../shared/ai-vault-session-filters'
import { conversationPreferenceKey } from '../../../../shared/conversation-navigation-preferences'
import {
  projectConversations,
  PROJECT_CONVERSATION_PAGE_SIZE
} from '../../../../shared/project-conversation-list'
import { PROJECT_ORDER_OPTIONS } from './sidebar-workspace-option-items'
import { useConversationPreferences } from './use-conversation-preferences'
import { ProjectConversationRow } from './ProjectConversationRow'
import { ProjectConversationSection } from './ProjectConversationSection'
import { SidebarConversationStart } from './SidebarConversationStart'
import {
  buildConversationProjectGroups,
  type ConversationProjectGroup
} from './project-conversation-groups'

export type ProjectConversationListProps = ComponentProps<typeof AiVaultSessionVirtualList> & {
  sessionProjects?: ReadonlyMap<string, AiVaultSessionProject>
  executionHostScope?: ExecutionHostScope
}
export function ProjectConversationList(props: ProjectConversationListProps): React.JSX.Element {
  useTranslation()
  const repos = useRepos()
  const worktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore(selectFolderWorkspaces)
  const activeExecutionHostId = useAppStore((state) => state.activeWorkspaceExecutionHostId)
  const catalog = useProjectHostSetupProjection()
  const order = useAppStore((state) => state.projectOrderBy)
  const manualOrder = useAppStore((state) => state.manualRepoOrder)
  const setOrder = useAppStore((state) => state.setProjectOrderBy)
  const activeWorkspaceId = useAppStore((state) => state.activeWorktreeId)
  const activeTab = useAppStore((state) =>
    state.activeWorktreeId ? state.getActiveTab(state.activeWorktreeId) : null
  )
  const { preferences, setPreference, projectVisibilitySupported, setProjectHidden } =
    useConversationPreferences()
  const [archived, setArchived] = useState(false)
  const [pageSizes, setPageSizes] = useState<Record<string, number>>({})
  const sessions = useMemo(
    () =>
      projectConversations(
        props.groups.flatMap((group) => group.sessions),
        preferences,
        archived
      ),
    [props.groups, preferences, archived]
  )
  const groups = useMemo(
    () =>
      buildConversationProjectGroups({
        sessions,
        sessionProjects: props.sessionProjects ?? new Map(),
        repos,
        worktrees,
        folders: folderWorkspaces,
        activeExecutionHostId,
        executionHostScope: props.executionHostScope,
        catalog,
        order,
        manualOrder,
        activeWorkspaceId
      }),
    [
      sessions,
      props.sessionProjects,
      repos,
      worktrees,
      folderWorkspaces,
      activeExecutionHostId,
      props.executionHostScope,
      catalog,
      order,
      manualOrder,
      activeWorkspaceId
    ]
  )
  const listRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(props.keyboardRef, () => ({
    handleKeyDown: (event) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = Array.from(
          listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-conversation-open]') ??
            []
        )
        const focused = document.activeElement
        const index = focused instanceof HTMLButtonElement ? buttons.indexOf(focused) : -1
        const next =
          index === -1
            ? event.key === 'ArrowDown'
              ? 0
              : buttons.length - 1
            : Math.max(
                0,
                Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))
              )
        if (buttons[next]) {
          event.preventDefault()
          buttons[next].focus()
        }
      }
    }
  }))
  const query = props.query?.trim() ?? ''
  const visibleGroups = groups.filter(
    (group) =>
      !preferences.hiddenProjects?.[group.key] &&
      (!(query || archived) || group.sessions.length > 0)
  )
  const orderLabels = new Map(PROJECT_ORDER_OPTIONS.map(({ id, label }) => [id, label]))
  const open = (session: AiVaultSession): void => {
    if (session.structuredSession) {
      props.onResume(session, session.structuredSession.workspaceId)
      return
    }
    const actions = resolveAiVaultSessionRowChatActions({
      session,
      originalPaneTarget: props.getOriginalPaneTarget(session),
      structuredSessionOpen: props.isStructuredSessionOpen(session),
      resumeState: props.getSessionResumeState(session),
      resumeInChat: props.getSessionResumeInChat(session),
      searchHit: props.searchHits?.get(session.id)
    })
    if (actions.canJumpToOriginalPane) {
      props.onJumpToOriginalPane(session)
    } else if (actions.resumeInNewChatWorkspaceId) {
      props.onResumeInNewChat(session, actions.resumeInNewChatWorkspaceId)
    } else if (actions.resumeWorktreeId) {
      props.onResume(session, actions.resumeWorktreeId)
    } else if (session.filePath) {
      props.onOpenLog(session)
    }
  }
  const move = (group: ConversationProjectGroup, direction: -1 | 1) => {
    const index = visibleGroups.findIndex((item) => item.key === group.key)
    const target = visibleGroups[index + direction]
    if (!target) {
      return
    }
    const all = [...repos]
    const isGroupRepo = (repo: (typeof repos)[number]) =>
      getRepoExecutionHostId(repo) === group.executionHostId && group.repoIds.has(repo.id)
    const block = all.filter(isGroupRepo)
    const rest = all.filter((repo) => !isGroupRepo(repo))
    const targetIndexes = rest.flatMap((repo, i) =>
      getRepoExecutionHostId(repo) === target.executionHostId && target.repoIds.has(repo.id)
        ? [i]
        : []
    )
    if (!targetIndexes.length) {
      return
    }
    const insertion = direction < 0 ? targetIndexes[0]! : targetIndexes.at(-1)! + 1
    rest.splice(insertion, 0, ...block)
    void useAppStore
      .getState()
      .reorderRepos(
        rest.map((repo) => repo.id),
        getManualRepoOrder(rest)
      )
      .catch(() =>
        toast.error(translate('sidebar.projectOrder.saveFailed', 'Could not save project order'))
      )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 px-3 py-1.5 text-xs text-muted-foreground">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="min-w-0"
              aria-label={translate('projectConversations.projectOrder', 'Project order')}
            >
              {orderLabels.get(order)}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={order}
              onValueChange={(value) => {
                if (value === 'recent' || value === 'manual') {
                  setOrder(value)
                }
              }}
            >
              {(['recent', 'manual'] as const).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {orderLabels.get(value)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={archived}
          onClick={() => setArchived(!archived)}
        >
          <Archive className="size-3.5" />
          {archived
            ? translate('projectConversations.allChats', 'Chats')
            : translate('projectConversations.archived', 'Archived')}
        </Button>
      </div>
      <div className="flex justify-end px-3">
        <HiddenConversationProjects
          projects={preferences.hiddenProjects}
          onRestore={
            projectVisibilitySupported
              ? (key, label) => void setProjectHidden(key, label, false)
              : undefined
          }
        />
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3 scrollbar-sleek"
        onKeyDown={(event) => {
          if (
            (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') ||
            event.target instanceof HTMLInputElement
          ) {
            return
          }
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button[data-conversation-open]'
            )
          )
          const focused = document.activeElement
          const index = focused instanceof HTMLButtonElement ? buttons.indexOf(focused) : -1
          const target = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]
          if (target) {
            event.preventDefault()
            target.focus()
          }
        }}
      >
        {visibleGroups.map((group, index) => {
          const size = query
            ? group.sessions.length
            : (pageSizes[group.key] ?? PROJECT_CONVERSATION_PAGE_SIZE)
          const collapsed = !query && props.collapsedGroups.has(group.key)
          return (
            <ProjectConversationSection
              key={group.key}
              label={group.label}
              icon={group.repo?.repoIcon}
              collapsed={collapsed}
              onToggle={() => props.onToggleGroup(group.key)}
              more={group.sessions.length > size}
              onMore={() =>
                setPageSizes((current) => ({
                  ...current,
                  [group.key]: size + PROJECT_CONVERSATION_PAGE_SIZE
                }))
              }
              newChat={
                !archived && group.workspaceId ? (
                  <SidebarConversationStart
                    worktreeId={group.workspaceId}
                    executionHostId={group.executionHostId}
                    projectName={group.label}
                  />
                ) : undefined
              }
              menu={
                <ConversationProjectMenu
                  group={group}
                  onHide={
                    projectVisibilitySupported
                      ? () => void setProjectHidden(group.key, group.label, true)
                      : undefined
                  }
                >
                  {order === 'manual' ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled={index === 0} onSelect={() => move(group, -1)}>
                        <ArrowUp />
                        {translate('projectConversations.moveUp', 'Move up')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === visibleGroups.length - 1}
                        onSelect={() => move(group, 1)}
                      >
                        <ArrowDown />
                        {translate('projectConversations.moveDown', 'Move down')}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </ConversationProjectMenu>
              }
            >
              {group.sessions.slice(0, size).map((session) => (
                <ProjectConversationRow
                  key={conversationPreferenceKey(session)}
                  session={session}
                  preference={preferences.entries[conversationPreferenceKey(session)]}
                  selected={
                    activeTab?.contentType === 'agent-session' &&
                    activeTab.entityId === session.structuredSession?.sessionId &&
                    (activeTab.executionHostId ?? 'local') === session.executionHostId
                  }
                  liveState={props.getSessionLiveState(session)}
                  onOpen={() => open(session)}
                  onPreference={(patch) => setPreference(conversationPreferenceKey(session), patch)}
                />
              ))}
              {group.sessions.length === 0 ? (
                <p className="py-1 pl-7 text-xs text-muted-foreground">
                  {translate('projectConversations.noChats', 'No chats yet')}
                </p>
              ) : null}
            </ProjectConversationSection>
          )
        })}
        {visibleGroups.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {props.loading
              ? translate('projectConversations.loading', 'Loading chats…')
              : archived
                ? translate('projectConversations.noArchived', 'No archived chats')
                : translate('projectConversations.noMatching', 'No matching chats')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

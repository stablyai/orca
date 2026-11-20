import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { Folder, GitBranch } from 'lucide-react'
import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/workspace/display/worktree-default-display-name'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '../../store/index'
import { ResumeTreeRow } from '../native-chat-recovery/tree/NativeChatResumeTreeRow'
import {
  resumeSelectionState,
  toggleResumeSelection
} from '../native-chat-recovery/tree/native-chat-resume-on-restart-grouping'
import { moveInTree } from '../native-chat-recovery/tree/native-chat-resume-tree-keys'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'

export type AgentSessionTreeSession = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
}

export type AgentSessionTreeGroup<Session extends AgentSessionTreeSession> = {
  key: string
  title: string
  sessions: Session[]
  /** Listed for information only: no checkboxes. */
  fixed?: true
}

type SessionSelection = {
  selected: ReadonlySet<string>
  onToggle: (ptyId: string, checked: boolean) => void
}

/** Group → workspace → session tree shared by the dialogs that restart agent sessions. */
export function AgentSessionTree<Session extends AgentSessionTreeSession>({
  label,
  groups,
  selected,
  onToggle,
  renderSession
}: SessionSelection & {
  label: string
  groups: AgentSessionTreeGroup<Session>[]
  renderSession: (session: Session, fixed: boolean) => React.ReactNode
}): React.JSX.Element {
  const treeRef = useRef<HTMLDivElement>(null)
  const pinnedIndex = useNextGroupBelowFold(treeRef, groups.length)
  return (
    <div
      ref={treeRef}
      role="tree"
      tabIndex={0}
      aria-label={label}
      className="relative max-h-64 min-h-0 scroll-py-8 overflow-y-auto scrollbar-sleek rounded-md bg-worktree-sidebar p-1.5 pb-2"
      onKeyDown={moveInTree}
    >
      {groups.map((group, index) => (
        <Fragment key={group.key}>
          {/* Unstuck position of the header below, to find the next group under the fold. */}
          <div data-group-anchor aria-hidden="true" />
          <GroupHeader
            group={group}
            pinnedToBottom={index === pinnedIndex}
            selected={selected}
            onToggle={onToggle}
          />
          {groupByWorkspace(group.sessions).map(([worktreeId, workspaceSessions]) => (
            <Fragment key={worktreeId}>
              <WorkspaceRow worktreeId={worktreeId} fixed={group.fixed} />
              {workspaceSessions.map((session) => (
                <Fragment key={session.ptyId}>{renderSession(session, !!group.fixed)}</Fragment>
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/** Pin only the first group header below the visible area, so that whole group is one click away. */
function useNextGroupBelowFold(
  treeRef: React.RefObject<HTMLDivElement | null>,
  groupCount: number
): number {
  const [pinned, setPinned] = useState(-1)
  useLayoutEffect(() => {
    const tree = treeRef.current
    if (!tree) {
      return
    }
    const update = (): void => {
      const viewBottom = tree.scrollTop + tree.clientHeight
      const anchors = [...tree.querySelectorAll<HTMLElement>('[data-group-anchor]')]
      // Why the header height: a header that is only partly visible still needs pinning.
      setPinned(
        anchors.findIndex(
          (anchor) => anchor.offsetTop + (anchor.nextElementSibling?.clientHeight ?? 0) > viewBottom
        )
      )
    }
    update()
    tree.addEventListener('scroll', update, { passive: true })
    return () => tree.removeEventListener('scroll', update)
  }, [treeRef, groupCount])
  return pinned
}

function groupByWorkspace<Session extends AgentSessionTreeSession>(
  sessions: readonly Session[]
): [string, Session[]][] {
  const groups = new Map<string, Session[]>()
  for (const session of sessions) {
    groups.set(session.worktreeId, [...(groups.get(session.worktreeId) ?? []), session])
  }
  return [...groups]
}

/** No checkbox, in the checkbox's column, so text lines up with rows that have one. */
const EMPTY_CHECKBOX_SLOT = <span aria-hidden="true" />

function GroupHeader({
  group,
  pinnedToBottom,
  selected,
  onToggle
}: SessionSelection & {
  group: AgentSessionTreeGroup<AgentSessionTreeSession>
  pinnedToBottom: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const ptyIds = group.sessions.map((session) => session.ptyId)
  const selection = resumeSelectionState(ptyIds, selected)
  return (
    <div
      data-pinned={pinnedToBottom}
      className="sticky -top-1.5 z-10 border-b border-worktree-sidebar-border bg-worktree-sidebar data-[pinned=true]:-bottom-2"
    >
      <ResumeTreeRow
        depth={0}
        name={group.title}
        checked={selection.checked}
        disabled={false}
        checkboxSlot={group.fixed ? EMPTY_CHECKBOX_SLOT : undefined}
        onCheckedChange={() => toggleResumeSelection(ptyIds, selection, onToggle)}
        checkboxLabel={t(
          'accounts.claude.switchSessions.selectGroup',
          'Select all sessions in {{group}}',
          { group: group.title }
        )}
      >
        <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">
          {group.title}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          ({group.sessions.length})
        </span>
      </ResumeTreeRow>
    </div>
  )
}

function WorkspaceRow({
  worktreeId,
  fixed
}: {
  worktreeId: string
  fixed?: true
}): React.JSX.Element {
  const worktree = useAppStore((store) => store.getKnownWorktreeById(worktreeId))
  const name = (worktree && resolveWorktreeDisplayName(worktree)) || worktreeId
  const branch = worktree ? resolveWorktreeBranchLabel(worktree) : ''
  const KindGlyph = branch ? GitBranch : Folder
  return (
    <ResumeTreeRow
      depth={1}
      name={name}
      checked={false}
      disabled
      checkboxSlot={EMPTY_CHECKBOX_SLOT}
      onCheckedChange={() => {}}
      checkboxLabel={name}
    >
      <KindGlyph className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span
        data-fixed={Boolean(fixed)}
        className="min-w-0 truncate text-[13px] font-medium text-foreground data-[fixed=true]:text-muted-foreground"
      >
        {name}
      </span>
      {branch && branch !== name && (
        <span className="min-w-0 shrink-2 truncate text-[11px] text-muted-foreground">
          {branch}
        </span>
      )}
    </ResumeTreeRow>
  )
}

/** A session titled by its last prompt, with its tab and why it can't restart (or whether it is busy) on the right. */
export function AgentSessionRow({
  session,
  agent,
  fallbackTitle,
  busy,
  reason,
  fixed,
  checked,
  onToggle
}: {
  session: AgentSessionTreeSession
  agent: TerminalAgent
  fallbackTitle: string
  busy: boolean
  reason?: string
  fixed: boolean
  checked: boolean
  onToggle: (ptyId: string, checked: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const paneKey = makePaneKey(session.tabId, session.leafId)
  const tabTitle = useAppStore((store) => {
    const tab = store.tabsByWorktree[session.worktreeId]?.find(
      (candidate) => candidate.id === session.tabId
    )
    return tab?.customTitle || tab?.title || ''
  })
  const lastPrompt = useAgentStatus(paneKey)?.prompt?.trim()
  const title = lastPrompt || tabTitle || fallbackTitle
  return (
    <ResumeTreeRow
      depth={2}
      compact
      name={title}
      checked={checked}
      disabled={false}
      checkboxSlot={fixed ? EMPTY_CHECKBOX_SLOT : undefined}
      onCheckedChange={(next) => onToggle(session.ptyId, next)}
      checkboxLabel={title}
    >
      <span role="img" aria-label={formatAgentTypeLabel(agent)} className="inline-flex shrink-0">
        <AgentIcon agent={agent} size={13} />
      </span>
      <span
        data-fixed={fixed}
        className="min-w-0 flex-1 truncate text-xs text-foreground/90 data-[fixed=true]:text-muted-foreground"
        title={title}
      >
        {title}
      </span>
      {lastPrompt && tabTitle && (
        <span className="min-w-0 max-w-28 shrink-0 truncate text-[11px] text-muted-foreground">
          {tabTitle}
        </span>
      )}
      <span className="max-w-40 shrink-0 truncate text-[11px] text-muted-foreground">
        {reason ??
          (busy
            ? t('accounts.claude.switchSessions.busy', 'Working')
            : t('accounts.claude.switchSessions.idle', 'Idle'))}
      </span>
    </ResumeTreeRow>
  )
}

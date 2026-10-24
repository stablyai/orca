import { useState } from 'react'
import { ChevronRight, CircleDot, GitMerge, GitPullRequest } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { getReviewStateTone } from '@/components/github/review-state-presentation'
import { workspaceAttachmentReferenceLabel } from '../../../../../shared/workspace-attachments'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { HostedReviewState } from '../../../../../shared/hosted-review'
import type { CheckStatus } from '../../../../../shared/github/pull-request-types'
import { ReviewIcon } from '../../sidebar/worktree-review-helpers'
import { workspaceAttachmentLabel } from '../../sidebar/worktree-attachment-editing'
import type { WorkspaceLinkedItemRow } from '../../sidebar/workspace-hover-attachments'
import { BrowserNewTabRow } from './browser-new-tab-row'
import { BrowserNewTabServerRow } from './browser-new-tab-server-row'
import type { BrowserNewTabServers } from './use-browser-new-tab-servers'

/** This workspace's running servers and linked reviews and tasks, then servers elsewhere on its host. */
export function BrowserNewTabWorkspaceCard({
  servers,
  linkedItems,
  runtimeTarget,
  openServersInPlace,
  onOpenUrl
}: {
  servers: BrowserNewTabServers
  linkedItems: WorkspaceLinkedItemRow[]
  runtimeTarget: RuntimeClientTarget | null
  openServersInPlace: boolean
  onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const [othersOpen, setOthersOpen] = useState(false)
  const own = runtimeTarget ? servers.own : []
  const others = runtimeTarget ? servers.others : []
  const serverRow = (server: BrowserNewTabServers['own'][number], showOwner: boolean) =>
    runtimeTarget ? (
      <BrowserNewTabServerRow
        key={`${server.port.connectHost}:${server.port.port}`}
        server={server}
        runtimeTarget={runtimeTarget}
        openInPlace={openServersInPlace}
        showOwner={showOwner}
        onOpenUrl={onOpenUrl}
      />
    ) : null

  return (
    <div className="flex flex-col gap-1.5">
      {own.length > 0 || linkedItems.length > 0 ? (
        <div className="flex flex-col gap-px rounded-xl border border-border bg-card p-1">
          {own.map((server) => serverRow(server, false))}
          {own.length > 0 && linkedItems.length > 0 ? (
            <div className="mx-2 my-1 h-px bg-border" />
          ) : null}
          {linkedItems.map((row) => (
            <LinkedItemRow key={row.key} row={row} onOpenUrl={onOpenUrl} />
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={othersOpen}
            onClick={() => setOthersOpen((open) => !open)}
            className="flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform motion-reduce:transition-none', {
                'rotate-90': othersOpen
              })}
            />
            {translate('browser.newTab.runningElsewhere', '{{count}} running in other workspaces', {
              count: others.length
            })}
          </button>
          {othersOpen ? (
            <div className="flex flex-col gap-px">
              {others.map((server) => serverRow(server, true))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function LinkedItemRow({
  row,
  onOpenUrl
}: {
  row: WorkspaceLinkedItemRow
  onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const { item, detail, live, url } = row
  const reference = workspaceAttachmentReferenceLabel(item, {
    pr: (number) => `#${number}`,
    issue: (number) => `#${number}`,
    mr: (number) => `!${number}`
  })
  const status = live ? reviewChecksLabel(live.status) : linkedTaskState(row)
  const reviewState = live?.state ? reviewStateLabel(live.state) : undefined
  return (
    <BrowserNewTabRow
      icon={<LinkedItemIcon row={row} />}
      title={detail?.title || item.title || live?.title || workspaceAttachmentLabel(item)}
      detail={
        <>
          <span className="font-mono">{reference}</span>
          {status ? ` · ${status}` : null}
        </>
      }
      trailing={
        reviewState && live?.state ? (
          <span
            className={cn(
              'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-2xs font-medium',
              getReviewStateTone(live.state)
            )}
          >
            {reviewState}
          </span>
        ) : null
      }
      onOpen={() => {
        if (url) {
          onOpenUrl(url)
        }
      }}
    />
  )
}

function LinkedItemIcon({ row }: { row: WorkspaceLinkedItemRow }): React.JSX.Element {
  const { item, live } = row
  if (live) {
    return <ReviewIcon review={live} className="size-4" />
  }
  if (item.provider === 'linear') {
    return <LinearIcon className="size-4 text-muted-foreground" />
  }
  if (item.provider === 'jira') {
    return <JiraIcon className="size-4 text-muted-foreground" />
  }
  if (item.type === 'mr') {
    return <GitMerge className="size-4 text-muted-foreground" />
  }
  if (item.type === 'pr') {
    return <GitPullRequest className="size-4 text-muted-foreground" />
  }
  return (
    <CircleDot
      className={
        linkedIssueState(row) === 'open'
          ? 'size-4 text-workspace-status-review/80'
          : 'size-4 text-muted-foreground'
      }
    />
  )
}

function reviewStateLabel(state: HostedReviewState): string {
  if (state === 'draft') {
    return translate('browser.newTab.state.draft', 'Draft')
  }
  if (state === 'merged') {
    return translate('browser.newTab.state.merged', 'Merged')
  }
  if (state === 'closed') {
    return translate('browser.newTab.state.closed', 'Closed')
  }
  return translate('browser.newTab.state.open', 'Open')
}

function reviewChecksLabel(status: CheckStatus | undefined): string | undefined {
  if (status === 'success') {
    return translate('browser.newTab.checks.passing', 'Checks passing')
  }
  if (status === 'failure') {
    return translate('browser.newTab.checks.failing', 'Checks failing')
  }
  if (status === 'pending') {
    return translate('browser.newTab.checks.pending', 'Checks pending')
  }
  return undefined
}

function linkedTaskState(row: WorkspaceLinkedItemRow): string | undefined {
  const { detail, liveTask } = row
  const stateName =
    detail?.stateName ?? (liveTask && 'stateName' in liveTask ? liveTask.stateName : undefined)
  if (stateName) {
    return stateName
  }
  const issueState = linkedIssueState(row)
  if (issueState === 'open') {
    return translate('browser.newTab.state.open', 'Open')
  }
  if (issueState === 'closed') {
    return translate('browser.newTab.state.closed', 'Closed')
  }
  return undefined
}

function linkedIssueState({
  detail,
  liveTask
}: Pick<WorkspaceLinkedItemRow, 'detail' | 'liveTask'>): 'open' | 'closed' | undefined {
  return detail?.issueState ?? (liveTask && 'number' in liveTask ? liveTask.state : undefined)
}

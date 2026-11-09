import React, { useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  File,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import { buildFileTree, type FileTreeNode } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { CloudArchiveInfo } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type {
  HostedArchiveCheckout,
  HostedArchivePullRequest
} from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'

export type ArchiveLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; archive: CloudArchiveInfo | null }

const PR_TONE: Record<HostedArchivePullRequest['state'], string> = {
  open: 'text-emerald-600 dark:text-emerald-400',
  draft: 'text-muted-foreground',
  merged: 'text-violet-600 dark:text-violet-400',
  closed: 'text-destructive'
}

function prStateLabel(state: HostedArchivePullRequest['state'], t: Translate): string {
  switch (state) {
    case 'open':
      return t('orcaCloudWorkspace.archived.prOpen', 'Open')
    case 'draft':
      return t('orcaCloudWorkspace.archived.prDraft', 'Draft')
    case 'merged':
      return t('orcaCloudWorkspace.archived.prMerged', 'Merged')
    case 'closed':
      return t('orcaCloudWorkspace.archived.prClosed', 'Closed')
  }
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-baseline gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {count !== undefined ? <span className="tabular-nums normal-case">{count}</span> : null}
      </h3>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

function relative(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  const rtf = new Intl.RelativeTimeFormat(getIntlLocale(), { numeric: 'auto' })
  if (Math.abs(minutes) < 60) {
    return rtf.format(-minutes, 'minute')
  }
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 48) {
    return rtf.format(-hours, 'hour')
  }
  return rtf.format(-Math.round(hours / 24), 'day')
}

function TreeRows({ nodes, depth }: { nodes: FileTreeNode[]; depth: number }): React.JSX.Element {
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} className="flex flex-col">
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} />
      ))}
    </ul>
  )
}

function TreeRow({ node, depth }: { node: FileTreeNode; depth: number }): React.JSX.Element {
  const isDir = node.children.length > 0
  const [open, setOpen] = useState(depth === 0 && isDir)
  const indent = { paddingLeft: `${depth * 12 + 4}px` }
  if (!isDir) {
    return (
      <li role="treeitem" aria-selected={false} className="flex h-6 items-center gap-1.5 truncate text-xs" style={indent}>
        <span className="w-3" />
        <File className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{node.name}</span>
      </li>
    )
  }
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={false}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 w-full items-center gap-1.5 rounded text-left text-xs hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={indent}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground motion-safe:transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        <Folder className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{node.name}</span>
      </button>
      {open ? <TreeRows nodes={node.children} depth={depth + 1} /> : null}
    </li>
  )
}

function CheckoutChanges({ checkout, now }: { checkout: HostedArchiveCheckout; now: number }) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">{checkout.branch ?? t('orcaCloudWorkspace.archived.detached', 'Detached HEAD')}</span>
        {checkout.upstream && (checkout.ahead || checkout.behind) ? (
          <span className="text-muted-foreground tabular-nums">
            {t('orcaCloudWorkspace.archived.aheadBehind', '↑{{ahead}} ↓{{behind}} vs {{upstream}}', {
              ahead: checkout.ahead ?? 0,
              behind: checkout.behind ?? 0,
              upstream: checkout.upstream
            })}
          </span>
        ) : null}
        {checkout.diffStat ? <span className="text-muted-foreground">· {checkout.diffStat}</span> : null}
      </div>
      {checkout.changes.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            {t('orcaCloudWorkspace.archived.uncommitted', 'Uncommitted changes')}
          </span>
          <ul className="flex flex-col font-mono text-[11px]">
            {checkout.changes.slice(0, 50).map((change) => (
              <li key={`${change.status}:${change.path}`} className="flex gap-2 truncate">
                <span className="w-4 shrink-0 text-amber-600 dark:text-amber-400">
                  {change.status === '??' ? 'U' : change.status}
                </span>
                <span className="truncate">{change.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {checkout.commits.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {checkout.commits.slice(0, 8).map((commit) => (
            <li key={commit.sha} className="flex items-start gap-2 text-xs">
              <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{commit.sha.slice(0, 7)}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{relative(commit.at, now)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t('orcaCloudWorkspace.archived.noCommits', 'No commits on this branch yet.')}</Empty>
      )}
    </div>
  )
}

/**
 * What an archived Orca Cloud workspace shows without waking it: PRs, last changes and the file
 * tree, from metadata the control plane captured at archive. Unarchive restores the same disk.
 */
export function CloudArchivedWorkspaceView({
  workspaceName,
  archivedAt,
  expiresAt,
  load,
  unarchiving,
  onUnarchive,
  onRetry,
  onOpenUrl,
  now: nowOverride
}: {
  workspaceName: string | null
  archivedAt: number | null
  expiresAt: number | null
  load: ArchiveLoad
  unarchiving: boolean
  onUnarchive: () => void
  onRetry: () => void
  onOpenUrl: (url: string) => void
  now?: number
}): React.JSX.Element {
  const t = useTranslate()
  const liveNow = useNow(60_000, nowOverride === undefined)
  const now = nowOverride ?? liveNow
  const archive = load.status === 'ready' ? load.archive : null
  const checkouts = archive?.metadata.checkouts ?? []
  const prs = archive?.metadata.pullRequests ?? []
  const primary = checkouts[0]
  const tree = useMemo(() => buildFileTree(primary?.files ?? []), [primary])
  const hiddenFiles = primary ? Math.max(0, primary.fileCount - primary.files.length) : 0

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-background scrollbar-sleek" data-cloud-archived-view="">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
              <Archive className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 space-y-0.5">
              <h2 className="truncate text-base font-semibold">
                {workspaceName ?? t('orcaCloudWorkspace.archived.title', 'Archived workspace')}
              </h2>
              <p className="text-xs text-muted-foreground">
                {archivedAt
                  ? t('orcaCloudWorkspace.archived.since', 'Archived {{when}}', { when: relative(archivedAt, now) })
                  : t('orcaCloudWorkspace.archived.title', 'Archived workspace')}
                {expiresAt
                  ? ` · ${t('orcaCloudWorkspace.archived.keptUntil', 'kept until {{date}}', {
                      date: new Date(expiresAt).toLocaleDateString(getIntlLocale())
                    })}`
                  : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  'orcaCloudWorkspace.archived.readOnly',
                  'This is a read-only snapshot. Unarchive to open terminals and agents again.'
                )}
              </p>
            </div>
          </div>
          <Button size="sm" onClick={onUnarchive} disabled={unarchiving}>
            {unarchiving ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
            {unarchiving
              ? t('orcaCloudWorkspace.archived.unarchiving', 'Unarchiving…')
              : t('orcaCloudWorkspace.unarchive', 'Unarchive')}
          </Button>
        </header>

        {load.status === 'loading' ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            {[60, 90, 75, 40].map((w, i) => (
              <span key={i} className="h-4 rounded bg-muted motion-safe:animate-pulse" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : load.status === 'error' ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-xs">
            <span className="text-muted-foreground">
              {t('orcaCloudWorkspace.archived.loadFailed', 'Couldn’t load the archive details.')}
            </span>
            <Button size="xs" variant="ghost" onClick={onRetry}>
              {t('orcaCloudWorkspace.retry', 'Retry')}
            </Button>
          </div>
        ) : (
          <>
            <Section title={t('orcaCloudWorkspace.archived.pullRequests', 'Pull requests')} count={prs.length}>
              {prs.length === 0 ? (
                <Empty>{t('orcaCloudWorkspace.archived.noPrs', 'No pull requests were open from this workspace.')}</Empty>
              ) : (
                <ul className="flex flex-col gap-1">
                  {prs.map((pr) => (
                    <li key={pr.url}>
                      <button
                        type="button"
                        onClick={() => onOpenUrl(pr.url)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <GitPullRequest className={cn('size-3.5 shrink-0', PR_TONE[pr.state])} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">#{pr.number}</span>
                        <span className={cn('shrink-0', PR_TONE[pr.state])}>{prStateLabel(pr.state, t)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={t('orcaCloudWorkspace.archived.lastChanges', 'Last changes')}>
              {checkouts.length === 0 ? (
                <Empty>
                  {t('orcaCloudWorkspace.archived.noRepo', 'No repository details were captured for this workspace.')}
                </Empty>
              ) : (
                checkouts.map((checkout) => <CheckoutChanges key={checkout.path} checkout={checkout} now={now} />)
              )}
            </Section>

            <Section
              title={t('orcaCloudWorkspace.archived.files', 'Files')}
              count={primary ? primary.fileCount : undefined}
            >
              {tree.length === 0 ? (
                <Empty>{t('orcaCloudWorkspace.archived.noFiles', 'No files were captured.')}</Empty>
              ) : (
                <div className="rounded-lg border border-border p-1.5">
                  <TreeRows nodes={tree} depth={0} />
                  {hiddenFiles > 0 ? (
                    <p className="px-1 pt-1 text-[11px] text-muted-foreground">
                      {t('orcaCloudWorkspace.archived.moreFiles', '{{count}} more files not shown', { count: hiddenFiles })}
                    </p>
                  ) : null}
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

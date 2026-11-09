import React, { useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  File,
  Folder,
  GitPullRequest,
  Loader2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsGroupHeader } from '@/components/settings/section-layout/SettingsGroup'
import { useNow } from '@/hooks/use-now'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  buildFileTree,
  formatRelative,
  formatShortDate,
  type FileTreeNode
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { CloudArchiveInfo } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedArchivePullRequest } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { CloudGitChanges } from './CloudGitChanges'
import { CloudWorkspaceHeader } from './CloudWorkspaceHeader'
import { FOCUS_RING } from './cloud-focus'

export type ArchiveLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; archive: CloudArchiveInfo | null }

const PR_TONE: Record<HostedArchivePullRequest['state'], string> = {
  open: 'text-emerald-600 dark:text-emerald-400',
  draft: 'text-muted-foreground',
  merged: 'text-violet-600 dark:text-violet-400',
  closed: 'text-red-600 dark:text-red-400'
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

function Section({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <SettingsGroupHeader
        title={
          <span className="flex items-baseline gap-1.5">
            {title}
            {count ? (
              <span className="text-sm font-normal tabular-nums text-muted-foreground">
                {new Intl.NumberFormat(getIntlLocale()).format(count)}
              </span>
            ) : null}
          </span>
        }
      />
      {children}
    </section>
  )
}

function TreeList({ nodes, depth }: { nodes: FileTreeNode[]; depth: number }): React.JSX.Element {
  return (
    <ul className="flex flex-col">
      {nodes.map((node) => (
        <TreeItem key={node.path} node={node} depth={depth} />
      ))}
    </ul>
  )
}

function TreeItem({ node, depth }: { node: FileTreeNode; depth: number }): React.JSX.Element {
  const isDir = node.children.length > 0
  const [open, setOpen] = useState(depth === 0 && isDir)
  const indent = { paddingLeft: `${depth * 12 + 4}px` }
  if (!isDir) {
    return (
      <li className="flex h-6 items-center gap-1.5 truncate text-xs" style={indent}>
        <span className="w-3" />
        <File className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{node.name}</span>
      </li>
    )
  }
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-6 w-full items-center gap-1.5 rounded text-left text-xs hover:bg-accent/50',
          FOCUS_RING
        )}
        style={indent}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground motion-safe:transition-transform',
            open && 'rotate-90'
          )}
          aria-hidden="true"
        />
        <Folder className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{node.name}</span>
      </button>
      {open ? <TreeList nodes={node.children} depth={depth + 1} /> : null}
    </li>
  )
}

/** Shaped like the loaded sections, so nothing jumps when they arrive. */
function ArchiveSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      {[2, 4, 5].map((rows, section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="mx-1 h-4 w-28" />
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            {Array.from({ length: rows }, (_, row) => (
              <Skeleton key={row} className="h-3" style={{ width: `${55 + ((row * 17) % 40)}%` }} />
            ))}
          </div>
        </div>
      ))}
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
  headingRef,
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
  headingRef?: React.Ref<HTMLHeadingElement>
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
  const nothing = load.status === 'ready' && prs.length === 0 && checkouts.length === 0
  const stateLine = [
    archivedAt
      ? t('orcaCloudWorkspace.archived.since', 'Archived {{when}}', {
          when: formatRelative(archivedAt, now)
        })
      : t('orcaCloudWorkspace.state.archived', 'Archived'),
    expiresAt
      ? t('orcaCloudWorkspace.archived.keptUntilShort', 'kept until {{date}}', {
          date: formatShortDate(expiresAt)
        })
      : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="absolute inset-0 z-30 overflow-y-auto bg-background scrollbar-sleek"
      data-cloud-archived-view=""
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
        <CloudWorkspaceHeader
          icon={Archive}
          title={workspaceName ?? t('orcaCloudWorkspace.archived.title', 'Archived workspace')}
          state="archived"
          stateLine={stateLine}
          note={t(
            'orcaCloudWorkspace.archived.readOnly',
            'A read-only snapshot. Unarchive to open terminals and agents again.'
          )}
          headingRef={headingRef}
          action={
            <Button
              size="sm"
              aria-disabled={unarchiving}
              className={cn(unarchiving && 'opacity-60')}
              onClick={() => {
                if (!unarchiving) {
                  onUnarchive()
                }
              }}
            >
              {unarchiving ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
              {unarchiving
                ? t('orcaCloudWorkspace.archived.unarchiving', 'Unarchiving…')
                : t('orcaCloudWorkspace.unarchive', 'Unarchive')}
            </Button>
          }
        />

        {load.status === 'loading' ? (
          <ArchiveSkeleton />
        ) : load.status === 'error' ? (
          <InlineError
            title={t(
              'orcaCloudWorkspace.archived.loadFailed',
              'Couldn’t load the archive details.'
            )}
            retryLabel={t('orcaCloudWorkspace.retry', 'Retry')}
            onRetry={onRetry}
          />
        ) : nothing ? (
          <p className="max-w-[60ch] text-sm text-muted-foreground">
            {t(
              'orcaCloudWorkspace.archived.nothing',
              'Nothing was captured for this workspace. Unarchive to open it.'
            )}
          </p>
        ) : (
          <>
            {prs.length > 0 ? (
              <Section
                title={t('orcaCloudWorkspace.archived.pullRequests', 'Pull requests')}
                count={prs.length}
              >
                <ul className="flex flex-col gap-1">
                  {prs.map((pr) => (
                    <li key={pr.url}>
                      <button
                        type="button"
                        onClick={() => onOpenUrl(pr.url)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/50',
                          FOCUS_RING
                        )}
                      >
                        <GitPullRequest
                          className={cn('size-3.5 shrink-0', PR_TONE[pr.state])}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          #{pr.number}
                        </span>
                        <span className={cn('shrink-0', PR_TONE[pr.state])}>
                          {prStateLabel(pr.state, t)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {checkouts.length > 0 ? (
              <Section title={t('orcaCloudWorkspace.archived.lastChanges', 'Last changes')}>
                {checkouts.map((checkout) => (
                  <CloudGitChanges key={checkout.path} data={checkout} now={now} />
                ))}
              </Section>
            ) : null}

            {tree.length > 0 ? (
              <Section
                title={t('orcaCloudWorkspace.archived.filesTitle', 'Files')}
                count={primary?.fileCount}
              >
                <div className="relative rounded-lg border border-border">
                  <div className="max-h-96 overflow-y-auto p-1.5 scrollbar-sleek [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]">
                    <TreeList nodes={tree} depth={0} />
                    {hiddenFiles > 0 ? (
                      <p className="px-1 pt-1 pb-4 text-[11px] text-muted-foreground">
                        {t(
                          'orcaCloudWorkspace.archived.moreFiles',
                          '{{count}} more files not shown',
                          {
                            count: hiddenFiles
                          }
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>
              </Section>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

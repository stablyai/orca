import React from 'react'
import { GitFork, Github, Gitlab, Globe } from 'lucide-react'
import { useAppStore } from '@/store'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { buildGitHubRepoUrl } from '../../../../../shared/github/repositories/links'
import type { RepoAppearanceUpdate } from '../../settings/repository/identity/use-repository-icon-actions'
import { RepoMarkTile, useRepoAutoMarkColor, useRepoMarkAppearance } from '../RepoMark'
import { ProjectAppearanceEditor } from './ProjectAppearanceEditor'
import { getProjectRemoteDisplay, type ProjectRemoteDisplay } from './project-remote-display'

const REMOTE_ICONS = { github: Github, gitlab: Gitlab, other: Globe } as const

function ExternalLinkLine({
  url,
  label,
  icon: Icon,
  title,
  children
}: {
  url: string | null
  label: string
  icon: React.ComponentType<{ className?: string }>
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  const content = (
    <>
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </>
  )
  if (!url) {
    return (
      <div className="flex min-w-0 items-center gap-1 text-muted-foreground" title={title}>
        {content}
      </div>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Reads as a plain link; it opens in the system browser rather than navigating Orca. */}
        <a
          href={url}
          onClick={(event) => {
            event.preventDefault()
            openAppHttpLink(url, { event, destination: 'system' })
          }}
          aria-label={label}
          className="flex w-fit max-w-full min-w-0 items-center gap-1 rounded-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {content}
        </a>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {url}
      </TooltipContent>
    </Tooltip>
  )
}

/** The repo name keeps up to 70% of the line; the namespace takes what is left. */
function SlugText({ slug }: { slug: string }): React.JSX.Element {
  const cut = slug.lastIndexOf('/')
  return (
    <span className="flex min-w-0">
      {cut > 0 ? (
        // Yields only once the repo name has taken its share, so short owners never truncate.
        <span className="min-w-0 truncate">{slug.slice(0, cut)}</span>
      ) : null}
      <span className="max-w-[70%] shrink-0 truncate">{cut > 0 ? slug.slice(cut) : slug}</span>
    </span>
  )
}

function RemoteLines({
  repo,
  remote
}: {
  repo: Repo
  remote: ProjectRemoteDisplay | null
}): React.JSX.Element {
  const t = useTranslate()
  const upstream = repo.upstream
  const upstreamSlug = upstream ? `${upstream.owner}/${upstream.repo}` : null
  return (
    <>
      {remote ? (
        <ExternalLinkLine
          url={remote.webUrl}
          icon={REMOTE_ICONS[remote.provider]}
          title={remote.host ? `${remote.host}/${remote.slug}` : remote.slug}
          label={t('auto.components.repo.ProjectPeek.openRemote', 'Open {{value0}} in browser', {
            value0: remote.slug
          })}
        >
          <SlugText slug={remote.slug} />
        </ExternalLinkLine>
      ) : (
        <span className="text-muted-foreground">
          {repo.kind === 'folder'
            ? t('auto.components.repo.ProjectPeek.folderProject', 'Folder · not a git repo')
            : t('auto.components.repo.ProjectPeek.noRemote', 'Local git repo · no remote')}
        </span>
      )}
      {upstream && upstreamSlug && upstreamSlug.toLowerCase() !== remote?.slug.toLowerCase() ? (
        <ExternalLinkLine
          url={buildGitHubRepoUrl(upstream)}
          icon={GitFork}
          label={t('auto.components.repo.ProjectPeek.openUpstream', 'Open {{value0}} in browser', {
            value0: upstreamSlug
          })}
        >
          {t('auto.components.repo.ProjectPeek.forkOf', 'Fork of {{value0}}', {
            value0: upstreamSlug
          })}
        </ExternalLinkLine>
      ) : null}
    </>
  )
}

function ProjectPeekHeader({
  repo,
  remote,
  onRequestClose
}: {
  repo: Repo
  remote: ProjectRemoteDisplay | null
  onRequestClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const appearance = useRepoMarkAppearance(repo)
  return (
    <div className="flex items-start gap-3 px-3 pt-3 pb-2">
      <RepoMarkTile appearance={appearance} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground">
          {repo.displayName}
        </span>
        <RemoteLines repo={repo} remote={remote} />
      </div>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className="self-center"
        onClick={onRequestClose}
      >
        {t('auto.components.repo.ProjectPeek.done', 'Done')}
      </Button>
    </div>
  )
}

export function ProjectPeek({
  repo,
  onRequestClose
}: {
  repo: Repo
  /** Closes the popover, e.g. before navigating to settings. */
  onRequestClose: () => void
}): React.JSX.Element {
  const storeUpdateRepo = useAppStore((state) => state.updateRepo)
  const autoColor = useRepoAutoMarkColor(repo)
  const hostId = getRepoExecutionHostId(repo)
  const remote = getProjectRemoteDisplay(repo)
  // Same-ID repos can exist on several hosts; write to the owner of this card's repo.
  const updateRepo = React.useCallback(
    (repoId: string, updates: RepoAppearanceUpdate) =>
      void storeUpdateRepo(repoId, updates, { hostId }),
    [storeUpdateRepo, hostId]
  )
  return (
    <div className="text-xs">
      <ProjectPeekHeader repo={repo} remote={remote} onRequestClose={onRequestClose} />
      <ProjectAppearanceEditor
        repo={repo}
        remote={remote}
        autoColor={autoColor}
        updateRepo={updateRepo}
        onRequestClose={onRequestClose}
      />
    </div>
  )
}

import React from 'react'
import { GitFork, Github, Gitlab, Globe, RotateCcw, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { buildGitHubRepoUrl } from '../../../../../shared/github/repositories/links'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../../shared/repository/appearance/repo-badge-color'
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
          {remote.slug}
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
  onOpenSettings,
  onReset
}: {
  repo: Repo
  remote: ProjectRemoteDisplay | null
  onOpenSettings: () => void
  onReset: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const appearance = useRepoMarkAppearance(repo)
  const optionsLabel = t('auto.components.repo.ProjectPeek.options', 'Options')
  const isDefault = repo.badgeColor === DEFAULT_REPO_BADGE_COLOR && repo.repoIcon == null
  return (
    <div className="flex items-center gap-3 px-3 pt-3 pb-2">
      <RepoMarkTile appearance={appearance} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground">
          {repo.displayName}
        </span>
        <RemoteLines repo={repo} remote={remote} />
      </div>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="muted-field-icon"
                size="icon-xs"
                aria-label={optionsLabel}
              >
                <Settings />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {optionsLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings />
            {t('auto.components.repo.ProjectPeek.openSettings', 'Open Settings')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isDefault} onSelect={onReset}>
            <RotateCcw />
            {t('auto.components.settings.RepositoryIconPicker.549d126081', 'Reset')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
  const t = useTranslate()
  const storeUpdateRepo = useAppStore((state) => state.updateRepo)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const autoColor = useRepoAutoMarkColor(repo)
  const hostId = getRepoExecutionHostId(repo)
  const remote = getProjectRemoteDisplay(repo)
  // Same-ID repos can exist on several hosts; write to the owner of this card's repo.
  // Why: the repo prop lags queued writes on a slow host. Every icon write from this card passes
  // here, so tab switches read the icon it last asked for until that write settles.
  const queuedIconRef = React.useRef<{ icon: RepoIcon | null } | null>(null)
  const updateRepo = React.useCallback(
    (repoId: string, updates: RepoAppearanceUpdate): Promise<boolean> => {
      const sent = storeUpdateRepo(repoId, updates, { hostId })
      if (!('repoIcon' in updates)) {
        return sent
      }
      const write = { icon: updates.repoIcon ?? null }
      queuedIconRef.current = write
      return sent.finally(() => {
        if (queuedIconRef.current === write) {
          queuedIconRef.current = null
        }
      })
    },
    [storeUpdateRepo, hostId]
  )
  const intendedIcon = (): RepoIcon | null =>
    queuedIconRef.current ? queuedIconRef.current.icon : (repo.repoIcon ?? null)
  const openRepoSettings = React.useCallback(() => {
    onRequestClose()
    openSettingsTarget({ pane: 'repo', repoId: repo.id })
    openSettingsPage()
  }, [onRequestClose, openSettingsPage, openSettingsTarget, repo.id])
  // Reset and Undo bump this so in-flight picks and previews never land on top of them.
  const [appearanceEpoch, setAppearanceEpoch] = React.useState(0)
  const reset = (): void => {
    const previous = { repoIcon: repo.repoIcon ?? null, badgeColor: repo.badgeColor }
    setAppearanceEpoch((epoch) => epoch + 1)
    // The default mark is the project's letters, so resetting clears the chosen icon and color.
    updateRepo(repo.id, { repoIcon: null, badgeColor: DEFAULT_REPO_BADGE_COLOR })
    toast(t('auto.components.repo.ProjectPeek.resetDone', 'Icon and color reset'), {
      action: {
        label: t('auto.components.repo.ProjectPeek.undo', 'Undo'),
        onClick: () => {
          setAppearanceEpoch((epoch) => epoch + 1)
          updateRepo(repo.id, previous)
        }
      }
    })
  }
  return (
    <div className="text-xs">
      <ProjectPeekHeader
        repo={repo}
        remote={remote}
        onOpenSettings={openRepoSettings}
        onReset={reset}
      />
      <ProjectAppearanceEditor
        repo={repo}
        remote={remote}
        autoColor={autoColor}
        appearanceEpoch={appearanceEpoch}
        intendedIcon={intendedIcon}
        updateRepo={updateRepo}
      />
    </div>
  )
}

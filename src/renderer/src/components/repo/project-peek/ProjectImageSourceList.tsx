import React from 'react'
import { Check, Globe, ImageUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  githubAvatarIcon,
  type RepoIcon
} from '../../../../../shared/repository/appearance/repo-icon'
import { useRepositoryIconImagePicks } from '../../settings/repository/identity/use-repository-icon-image-picks'
import { RepoIconGlyph } from '../repo-icon'
import type { ProjectRemoteDisplay } from './project-remote-display'

type FetchStatus = 'idle' | 'fetching' | 'invalid' | 'notFound'

/** The domain a stored favicon was fetched for, read back from its lookup URL. */
function faviconDomain(repoIcon: Repo['repoIcon']): string {
  if (repoIcon?.type !== 'image' || repoIcon.source !== 'favicon') {
    return ''
  }
  try {
    return new URL(repoIcon.src).searchParams.get('domain') ?? ''
  } catch {
    return ''
  }
}

function PlaceholderThumb({ icon: Icon }: { icon: typeof Globe }): React.JSX.Element {
  return (
    <span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] bg-muted text-muted-foreground">
      <Icon className="size-3" />
    </span>
  )
}

function SourceThumb({ repoIcon }: { repoIcon: RepoIcon }): React.JSX.Element {
  return (
    <RepoIconGlyph
      repoIcon={repoIcon}
      className="size-[18px] shrink-0"
      iconClassName="size-[18px]"
    />
  )
}

function SourceRow({
  thumb,
  label,
  detail,
  active,
  busy = false,
  error = false,
  disabled = false,
  expanded,
  onClick
}: {
  thumb: React.ReactNode
  label: string
  detail?: string
  active: boolean
  busy?: boolean
  error?: boolean
  disabled?: boolean
  expanded?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    // Bleeds 8px past the content edge so the hover fill has room while thumbs stay on the edge.
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        '-mx-2 flex h-[30px] w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left text-settings-detail text-foreground outline-none transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        active && 'bg-accent hover:bg-accent'
      )}
    >
      {thumb}
      <span className={cn('min-w-0 flex-1 truncate', error && 'text-destructive')}>{label}</span>
      {detail && !error ? (
        <span className="max-w-[45%] truncate text-2xs text-muted-foreground">{detail}</span>
      ) : null}
      {busy ? (
        <span className="inline-flex shrink-0 text-muted-foreground">
          <LoadingSpinner className="size-3.5" />
        </span>
      ) : (
        <Check
          aria-hidden="true"
          className={cn('size-3.5 shrink-0', active ? 'visible' : 'invisible')}
        />
      )}
    </button>
  )
}

/** Image icon sources as one list: GitHub avatar, website icon, uploaded PNG. */
export function ProjectImageSourceList({
  repo,
  remote,
  loadingGitHub,
  onUseGitHubAvatar,
  onSetIcon
}: {
  repo: Repo
  remote: ProjectRemoteDisplay | null
  loadingGitHub: boolean
  onUseGitHubAvatar: () => void
  onSetIcon: (repoIcon: RepoIcon | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [sizeError, setSizeError] = React.useState(false)
  const { uploadImage, fetchWebsiteFavicon } = useRepositoryIconImagePicks(onSetIcon, {
    onTooLarge: () => setSizeError(true)
  })
  const repoIcon = repo.repoIcon
  const source = repoIcon?.type === 'image' ? repoIcon.source : null
  const activeDomain = faviconDomain(repoIcon)
  const [websiteOpen, setWebsiteOpen] = React.useState(source === 'favicon')
  const [website, setWebsite] = React.useState(activeDomain)
  const [status, setStatus] = React.useState<FetchStatus>('idle')
  const focusFieldRef = React.useRef(false)

  const githubPreview =
    remote?.owner && remote.name
      ? githubAvatarIcon({ owner: remote.owner, repo: remote.name, host: remote.host ?? undefined })
      : null

  const fetchIcon = async (): Promise<void> => {
    setSizeError(false)
    setStatus('fetching')
    const result = await fetchWebsiteFavicon(website)
    setStatus(result === 'applied' ? 'idle' : result)
  }

  const fieldError =
    status === 'notFound'
      ? t('auto.components.repo.ProjectPeek.noIconFound', 'No icon found')
      : status === 'invalid'
        ? t(
            'auto.components.settings.RepositoryIconPicker.acf31559a0',
            'Enter a valid website URL.'
          )
        : null

  return (
    <div className="flex flex-col gap-px">
      {githubPreview && remote?.owner ? (
        <SourceRow
          thumb={<SourceThumb repoIcon={githubPreview} />}
          label={t('auto.components.repo.ProjectPeek.githubAvatar', 'GitHub avatar')}
          detail={`@${remote.owner}`}
          active={source === 'github'}
          busy={loadingGitHub}
          disabled={loadingGitHub}
          onClick={() => {
            setSizeError(false)
            if (source !== 'github') {
              onUseGitHubAvatar()
            }
          }}
        />
      ) : null}
      <SourceRow
        thumb={
          source === 'favicon' && repoIcon ? (
            <SourceThumb repoIcon={repoIcon} />
          ) : (
            <PlaceholderThumb icon={Globe} />
          )
        }
        label={t('auto.components.repo.ProjectPeek.websiteIcon', 'Website icon')}
        detail={activeDomain || undefined}
        active={source === 'favicon'}
        expanded={websiteOpen}
        onClick={() => {
          setSizeError(false)
          focusFieldRef.current = !websiteOpen
          setWebsiteOpen(!websiteOpen)
        }}
      />
      {websiteOpen ? (
        <form
          className="mt-[3px] mb-0.5"
          onSubmit={(event) => {
            event.preventDefault()
            void fetchIcon()
          }}
        >
          {/* Why a drawn field: the status icon and Fetch sit inside it, so the input is the embedded text run. */}
          <div
            className={cn(
              'flex h-[30px] items-center gap-2 rounded-lg border border-input bg-background/60 pr-1 pl-2 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30',
              fieldError && 'border-destructive focus-within:border-destructive'
            )}
          >
            <span className="inline-flex shrink-0 text-muted-foreground">
              {status === 'fetching' ? (
                <LoadingSpinner className="size-3.5" />
              ) : (
                <Globe aria-hidden="true" className="size-3.5" />
              )}
            </span>
            <Input
              ref={(input) => {
                if (input && focusFieldRef.current) {
                  focusFieldRef.current = false
                  input.focus()
                }
              }}
              surface="embedded"
              density="row"
              value={website}
              // A fetch applies the URL it started with, so the text holds still until it settles.
              readOnly={status === 'fetching'}
              onChange={(event) => {
                setWebsite(event.target.value)
                setStatus('idle')
              }}
              placeholder={t(
                'auto.components.settings.RepositoryIconPicker.03ca1a4e9b',
                'example.com'
              )}
              aria-label={t(
                'auto.components.repo.ProjectPeek.faviconPlaceholder',
                'Website for favicon'
              )}
              aria-invalid={fieldError ? true : undefined}
            />
            <Button
              type="submit"
              variant="secondary"
              size="xs"
              className="h-[22px] shrink-0"
              disabled={!website.trim() || status === 'fetching'}
            >
              {t('auto.components.repo.ProjectPeek.fetchIcon', 'Fetch')}
            </Button>
          </div>
          {fieldError ? (
            <p role="alert" className="mt-1.5 text-2xs text-destructive">
              {fieldError}
            </p>
          ) : null}
        </form>
      ) : null}
      <SourceRow
        thumb={
          source === 'upload' && repoIcon ? (
            <SourceThumb repoIcon={repoIcon} />
          ) : (
            <PlaceholderThumb icon={ImageUp} />
          )
        }
        label={
          sizeError
            ? t('auto.components.repo.ProjectPeek.uploadTooLarge', 'Over 256 KB')
            : source === 'upload'
              ? t('auto.components.repo.ProjectPeek.uploadedImage', 'Image')
              : t('auto.components.settings.RepositoryIconPicker.381b4844fd', 'Upload PNG')
        }
        detail={source === 'upload' && repoIcon?.type === 'image' ? repoIcon.label : undefined}
        active={source === 'upload'}
        error={sizeError}
        onClick={() => {
          setSizeError(false)
          void uploadImage()
        }}
      />
    </div>
  )
}

import React from 'react'
import { Check, Github, Smile } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  githubAvatarIcon,
  MAX_REPO_MONOGRAM_CHARACTERS,
  sanitizeRepoMonogramText,
  type RepoIcon
} from '../../../../../shared/repository/appearance/repo-icon'
import { suggestRepoMonogram } from '../../../../../shared/repository/appearance/repo-monogram'
import {
  repoMarkKey,
  resolveRepoMarkAppearances
} from '../../../../../shared/repository/appearance/repo-mark-appearance'
import { getRepoLucideIconOptions, RepoIconGlyph } from '../repo-icon'
import { useRepoMarkAppearance } from '../RepoMark'
import type { ProjectRemoteDisplay } from './project-remote-display'
import { ProjectIconSourcePanel } from './ProjectIconSourcePanel'

// Package and Box draw the same cube at this size; keep Box only for projects already using it.
const VISUALLY_DUPLICATE_ICONS = new Set(['Box'])

export function IconTile({
  label,
  selected = false,
  active = false,
  disabled = false,
  onClick,
  children
}: {
  label: string
  selected?: boolean
  /** Its panel is expanded; distinct from being the current icon. */
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      aria-expanded={active || undefined}
      title={label}
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-md text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        // Same selection ring as the color swatches; a transparent offset shows the real card behind.
        active && 'bg-accent',
        selected && 'bg-accent ring-2 ring-foreground/80 ring-offset-1 ring-offset-transparent'
      )}
    >
      {children}
    </button>
  )
}

/** Letters other projects already show, chosen or default, so suggestions stay distinct. */
function useTakenMonograms(repo: Repo): string[] {
  const repos = useAppStore((state) => state.repos)
  const key = repoMarkKey(repo)
  return React.useMemo(() => {
    const taken: string[] = []
    for (const [otherKey, appearance] of resolveRepoMarkAppearances(repos)) {
      if (otherKey !== key && appearance.icon.type === 'letters') {
        taken.push(appearance.icon.text)
      }
    }
    return taken
  }, [repos, key])
}

export function useSuggestedMonogram(repo: Repo): string {
  const taken = useTakenMonograms(repo)
  return React.useMemo(
    () => suggestRepoMonogram(repo.displayName, taken),
    [repo.displayName, taken]
  )
}

export function LettersPanel({
  repo,
  color,
  onSetIcon
}: {
  repo: Repo
  color: string
  onSetIcon: (repoIcon: RepoIcon) => void
}): React.JSX.Element {
  const t = useTranslate()
  const taken = useTakenMonograms(repo)
  const shown = useRepoMarkAppearance(repo).icon
  // With no icon chosen the mark already shows default letters; the field reflects them.
  const current = shown.type === 'letters' ? shown.text : ''
  // While typing, show the draft; otherwise always mirror the saved letters.
  const [draft, setDraft] = React.useState<string | null>(null)
  // Offer the smart pick plus the next distinct alternatives, so one click usually lands it.
  const suggestions = React.useMemo(() => {
    const picks: string[] = []
    for (let index = 0; index < 4; index++) {
      const next = suggestRepoMonogram(repo.displayName, [...taken, ...picks])
      if (picks.includes(next)) {
        break
      }
      picks.push(next)
    }
    return picks
  }, [repo.displayName, taken])

  const apply = (value: string): void => {
    const text = sanitizeRepoMonogramText(value.toLocaleUpperCase())
    setDraft(text ?? '')
    if (text) {
      onSetIcon({ type: 'letters', text })
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={draft ?? current}
        onFocus={() => setDraft(current)}
        onChange={(event) => apply(event.target.value)}
        // Leaving the field drops an emptied draft, so it never hides letters the mark still shows.
        onBlur={() => setDraft(null)}
        maxLength={MAX_REPO_MONOGRAM_CHARACTERS * 2}
        density="compact"
        className="flex-1"
        aria-label={t('auto.components.repo.ProjectPeek.lettersInput', 'Up to 2 letters')}
        placeholder={t('auto.components.repo.ProjectPeek.lettersPlaceholder', '1–2 letters')}
      />
      <div className="flex shrink-0 gap-1">
        {suggestions
          .filter((suggestion) => suggestion !== current)
          .slice(0, 3)
          .map((suggestion) => (
            <IconTile
              key={suggestion}
              label={t('auto.components.repo.ProjectPeek.useLetters', 'Use “{{value0}}”', {
                value0: suggestion
              })}
              onClick={() => apply(suggestion)}
            >
              <RepoIconGlyph
                repoIcon={{ type: 'letters', text: suggestion }}
                color={color}
                className="size-5"
                iconClassName="size-5"
              />
            </IconTile>
          ))}
      </div>
    </div>
  )
}

export function GlyphPanel({
  repo,
  color,
  onSetIcon
}: {
  repo: Repo
  /** The mark's color, so the grid previews each icon as it will look. */
  color: string
  onSetIcon: (repoIcon: RepoIcon | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [emojiOpen, setEmojiOpen] = React.useState(false)
  const selectedLucideName = repo.repoIcon?.type === 'lucide' ? repo.repoIcon.name : null
  const emoji = repo.repoIcon?.type === 'emoji' ? repo.repoIcon.emoji : ''
  const options = getRepoLucideIconOptions().filter(
    (option) => !VISUALLY_DUPLICATE_ICONS.has(option.name) || option.name === selectedLucideName
  )
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-9 justify-items-center gap-1 px-0.5">
        {options.map((option) => (
          <IconTile
            key={option.name}
            label={option.label}
            selected={selectedLucideName === option.name}
            onClick={() => onSetIcon({ type: 'lucide', name: option.name })}
          >
            <option.icon className="size-3.5" style={{ color }} />
          </IconTile>
        ))}
        <IconTile
          label={t('auto.components.settings.RepositoryIconPicker.c490787d24', 'Emoji')}
          selected={emoji !== ''}
          active={emojiOpen}
          onClick={() => setEmojiOpen((open) => !open)}
        >
          {emoji ? (
            <span className="text-sm leading-none">{emoji}</span>
          ) : (
            <Smile className="size-3.5" />
          )}
        </IconTile>
      </div>
      {emojiOpen ? (
        <ProjectIconSourcePanel source="emoji" selectedEmoji={emoji} onSetIcon={onSetIcon} />
      ) : null}
    </div>
  )
}

export function PicturePanel({
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
  const usingGitHubAvatar = repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github'
  const githubPreview =
    remote?.owner && remote.name
      ? githubAvatarIcon({ owner: remote.owner, repo: remote.name, host: remote.host ?? undefined })
      : null
  return (
    <div className="space-y-2">
      {githubPreview ? (
        <Button
          type="button"
          variant={usingGitHubAvatar ? 'secondary' : 'outline'}
          size="xs"
          className="w-full justify-start"
          aria-pressed={usingGitHubAvatar}
          disabled={loadingGitHub}
          onClick={usingGitHubAvatar ? undefined : onUseGitHubAvatar}
        >
          <RepoIconGlyph repoIcon={githubPreview} className="size-4" iconClassName="size-4" />
          {usingGitHubAvatar
            ? t('auto.components.repo.ProjectPeek.usingGitHubAvatar', 'Using the GitHub avatar')
            : t('auto.components.settings.RepositoryIconPicker.cc76342291', 'Use GitHub avatar')}
          {usingGitHubAvatar ? <Check className="ml-auto" /> : <Github className="ml-auto" />}
        </Button>
      ) : null}
      <ProjectIconSourcePanel source="image" selectedEmoji="" onSetIcon={onSetIcon} />
    </div>
  )
}

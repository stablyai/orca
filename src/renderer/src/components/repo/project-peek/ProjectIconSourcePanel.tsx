import React, { Suspense } from 'react'
import { ImageUp, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { useRepositoryIconImagePicks } from '../../settings/repository/identity/use-repository-icon-image-picks'

const RepositoryIconEmojiPicker = lazyWithRetry(
  () =>
    import('../../settings/repository/identity/RepositoryIconEmojiPicker').then((module) => ({
      default: module.RepositoryIconEmojiPicker
    })),
  { reloadKey: 'repo-icon-emoji-picker' }
)

export type ProjectIconSource = 'emoji' | 'image'

/** The emoji and image icon sources, expanded inline under the icon grid. */
export function ProjectIconSourcePanel({
  source,
  selectedEmoji,
  onSetIcon
}: {
  source: ProjectIconSource
  selectedEmoji: string
  onSetIcon: (repoIcon: RepoIcon | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [website, setWebsite] = React.useState('')
  const { uploadImage, applyWebsiteFavicon } = useRepositoryIconImagePicks(onSetIcon)

  if (source === 'emoji') {
    return (
      <Suspense fallback={<div className="h-[280px] animate-pulse rounded-md bg-muted" />}>
        <RepositoryIconEmojiPicker compact selectedEmoji={selectedEmoji} onSetIcon={onSetIcon} />
      </Suspense>
    )
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="w-full"
        onClick={() => void uploadImage()}
      >
        <ImageUp />
        {t('auto.components.settings.RepositoryIconPicker.381b4844fd', 'Upload PNG')}
      </Button>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (applyWebsiteFavicon(website)) {
            setWebsite('')
          }
        }}
      >
        <Input
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          placeholder={t(
            'auto.components.repo.ProjectPeek.faviconPlaceholder',
            'Website for favicon'
          )}
          aria-label={t(
            'auto.components.repo.ProjectPeek.faviconPlaceholder',
            'Website for favicon'
          )}
          density="compact"
        />
        <Button type="submit" variant="outline" size="xs" disabled={!website.trim()}>
          <Link2 />
          {t('auto.components.settings.RepositoryIconPicker.cc1286e263', 'Favicon')}
        </Button>
      </form>
      <p className="text-2xs text-muted-foreground">
        {t(
          'auto.components.settings.RepositoryIconPicker.fde066a63b',
          'PNG uploads must be 256KB or smaller.'
        )}
      </p>
    </div>
  )
}

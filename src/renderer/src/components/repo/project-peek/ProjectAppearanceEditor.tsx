import React from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { explicitRepoMarkColor } from '../../../../../shared/repository/appearance/repo-mark-appearance'
import { RepositoryIconColorSection } from '../../settings/repository/identity/RepositoryIconColorSection'
import {
  useRepositoryIconActions,
  type RepoAppearanceUpdate
} from '../../settings/repository/identity/use-repository-icon-actions'
import type { ProjectRemoteDisplay } from './project-remote-display'
import { GlyphPanel, LettersPanel, useSuggestedMonogram } from './ProjectIconStylePanels'
import { ProjectImageSourceList } from './ProjectImageSourceList'

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-2xs font-medium text-muted-foreground">{children}</div>
}

type IconStyle = 'letters' | 'icon' | 'image'

/** The fill the letters will show: the picked color, else what Auto resolves to. */
function autoColorFor(repo: Repo, autoColor: string): string {
  return explicitRepoMarkColor(repo.badgeColor) ?? autoColor
}

function iconStyleOf(repoIcon: Repo['repoIcon']): IconStyle {
  // No chosen icon means the default letters.
  if (repoIcon == null || repoIcon.type === 'letters') {
    return 'letters'
  }
  return repoIcon.type === 'image' ? 'image' : 'icon'
}

export function ProjectAppearanceEditor({
  repo,
  remote,
  autoColor,
  appearanceEpoch,
  intendedIcon,
  updateRepo
}: {
  repo: Repo
  remote: ProjectRemoteDisplay | null
  autoColor: string
  /** Changes on Reset and Undo, which supersede any preview or fetch still pending. */
  appearanceEpoch: number
  /** The icon this card last asked for, or the saved one once its writes have landed. */
  intendedIcon: () => RepoIcon | null
  /** Settles once the write is applied; writes for one repo apply in order. */
  updateRepo: (repoId: string, updates: RepoAppearanceUpdate) => Promise<unknown>
}): React.JSX.Element {
  const t = useTranslate()
  // Why: opening Letters previews a suggestion; browsing away untouched must give the old icon back.
  const previewedFromRef = React.useRef<{ icon: RepoIcon | null; epoch: number } | null>(null)
  const currentEpoch = useLatestHandler(() => appearanceEpoch)
  // Any icon write from this editor, the GitHub action included, ends the preview. A write begun
  // before a Reset or Undo (a GitHub lookup, upload or favicon still resolving) is dropped.
  const writeAppearance = (repoId: string, updates: RepoAppearanceUpdate): Promise<unknown> => {
    if (appearanceEpoch !== currentEpoch()) {
      return Promise.resolve(false)
    }
    if ('repoIcon' in updates) {
      previewedFromRef.current = null
    }
    return updateRepo(repoId, updates)
  }
  const actions = useRepositoryIconActions(repo, writeAppearance)
  const [style, setStyle] = React.useState<IconStyle>(() => iconStyleOf(repo.repoIcon))
  const suggestedLetters = useSuggestedMonogram(repo)
  const setIcon = (repoIcon: RepoIcon | null): void => {
    void writeAppearance(repo.id, { repoIcon })
  }

  const chooseStyle = (next: IconStyle): void => {
    setStyle(next)
    const current = intendedIcon()
    // Letters need no further input, so switching to them previews the smart pick right away.
    if (next === 'letters' && current != null && current.type !== 'letters') {
      setIcon({ type: 'letters', text: suggestedLetters })
      previewedFromRef.current = { icon: current, epoch: appearanceEpoch }
      return
    }
    const previewed = previewedFromRef.current
    // Edits clear the preview; a Reset or Undo since then wins. Repo updates apply in order, so
    // this restore lands after the preview even if the preview has not reached the store yet.
    if (previewed && previewed.epoch === appearanceEpoch) {
      setIcon(previewed.icon)
    }
    previewedFromRef.current = null
  }

  return (
    <div className="space-y-3 px-3 pt-1 pb-3">
      <Tabs
        value={style}
        onValueChange={(value) => {
          if (value === 'letters' || value === 'icon' || value === 'image') {
            chooseStyle(value)
          }
        }}
      >
        <TabsList size="segmented" className="w-full">
          <TabsTrigger value="letters">
            {t('auto.components.repo.ProjectPeek.styleLetters', 'Letters')}
          </TabsTrigger>
          <TabsTrigger value="icon">
            {t('auto.components.settings.RepositoryIconPicker.b2d7fd2116', 'Icon')}
          </TabsTrigger>
          <TabsTrigger value="image">
            {t('auto.components.repo.ProjectPeek.styleImage', 'Image')}
          </TabsTrigger>
        </TabsList>
        {/* Images keep their own colors, so color only applies to letters and icons. */}
        {repo.repoIcon?.type === 'image' ? null : (
          <div className="space-y-1.5">
            <SectionLabel>
              {t('auto.components.settings.RepositoryIconPicker.642dc29c6d', 'Color')}
            </SectionLabel>
            <RepositoryIconColorSection
              compact
              autoColor={autoColor}
              badgeColor={repo.badgeColor}
              onBadgeColorChange={(badgeColor) => updateRepo(repo.id, { badgeColor })}
            />
          </div>
        )}
        <TabsContent value="letters" className="mt-1">
          <LettersPanel repo={repo} color={autoColorFor(repo, autoColor)} onSetIcon={setIcon} />
        </TabsContent>
        <TabsContent value="icon" className="mt-1">
          <GlyphPanel repo={repo} color={autoColorFor(repo, autoColor)} onSetIcon={setIcon} />
        </TabsContent>
        {/* Extra room under the Color row, so the swatches don't read as part of the source list. */}
        <TabsContent value="image" className={repo.repoIcon?.type === 'image' ? 'mt-1' : 'mt-3'}>
          <ProjectImageSourceList
            // A fresh list on Reset or Undo drops any fetch still loading and its error.
            key={`${repo.id}:${appearanceEpoch}`}
            repo={repo}
            remote={remote}
            loadingGitHub={actions.loadingGitHub}
            onUseGitHubAvatar={() => void actions.applyGitHubAvatar()}
            onSetIcon={setIcon}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

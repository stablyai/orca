import React from 'react'
import { toast } from 'sonner'
import { RotateCcw, Settings } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { explicitRepoMarkColor } from '../../../../../shared/repository/appearance/repo-mark-appearance'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../../shared/repository/appearance/repo-badge-color'
import { RepositoryIconColorSection } from '../../settings/repository/identity/RepositoryIconColorSection'
import {
  useRepositoryIconActions,
  type RepoAppearanceUpdate
} from '../../settings/repository/identity/use-repository-icon-actions'
import { getRepositoryIconSectionId } from '../../settings/repository/repository-settings-targets'
import type { ProjectRemoteDisplay } from './project-remote-display'
import {
  GlyphPanel,
  LettersPanel,
  PicturePanel,
  useSuggestedMonogram
} from './ProjectIconStylePanels'

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-2xs font-medium text-muted-foreground">{children}</div>
}

type IconStyle = 'letters' | 'icon' | 'picture'

/** The fill the letters will show: the picked color, else what Auto resolves to. */
function autoColorFor(repo: Repo, autoColor: string): string {
  return explicitRepoMarkColor(repo.badgeColor) ?? autoColor
}

function iconStyleOf(repoIcon: Repo['repoIcon']): IconStyle {
  // No chosen icon means the default letters.
  if (repoIcon == null || repoIcon.type === 'letters') {
    return 'letters'
  }
  return repoIcon.type === 'image' ? 'picture' : 'icon'
}

export function ProjectAppearanceEditor({
  repo,
  remote,
  autoColor,
  updateRepo,
  onRequestClose
}: {
  repo: Repo
  remote: ProjectRemoteDisplay | null
  autoColor: string
  updateRepo: (repoId: string, updates: RepoAppearanceUpdate) => void
  onRequestClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const actions = useRepositoryIconActions(repo, updateRepo)
  const [style, setStyle] = React.useState<IconStyle>(() => iconStyleOf(repo.repoIcon))
  const suggestedLetters = useSuggestedMonogram(repo)
  // Why: opening Letters previews a suggestion; browsing away untouched must give the old icon back.
  const previewedFromRef = React.useRef<{ icon: RepoIcon | null } | null>(null)
  const setIcon = (repoIcon: RepoIcon | null): void => {
    previewedFromRef.current = null
    updateRepo(repo.id, { repoIcon })
  }

  const chooseStyle = (next: IconStyle): void => {
    setStyle(next)
    // Letters need no further input, so switching to them previews the smart pick right away.
    if (next === 'letters' && repo.repoIcon != null && repo.repoIcon.type !== 'letters') {
      const previous = repo.repoIcon ?? null
      setIcon({ type: 'letters', text: suggestedLetters })
      previewedFromRef.current = { icon: previous }
      return
    }
    const previewed = previewedFromRef.current
    if (previewed) {
      setIcon(previewed.icon)
    }
  }

  const openIconSettings = (): void => {
    onRequestClose()
    openSettingsTarget({
      pane: 'repo',
      repoId: repo.id,
      sectionId: getRepositoryIconSectionId(repo.id)
    })
    openSettingsPage()
  }

  const isDefault = repo.badgeColor === DEFAULT_REPO_BADGE_COLOR && repo.repoIcon == null
  const reset = async (): Promise<void> => {
    const previous = {
      repoIcon: repo.repoIcon ?? null,
      badgeColor: repo.badgeColor
    }
    await actions.resetToDefault()
    updateRepo(repo.id, { badgeColor: DEFAULT_REPO_BADGE_COLOR })
    toast(t('auto.components.repo.ProjectPeek.resetDone', 'Icon and color reset'), {
      action: {
        label: t('auto.components.repo.ProjectPeek.undo', 'Undo'),
        onClick: () => updateRepo(repo.id, previous)
      }
    })
  }

  return (
    <>
      <div className="space-y-3 px-3 pt-1 pb-3">
        <Tabs
          value={style}
          onValueChange={(value) => {
            if (value === 'letters' || value === 'icon' || value === 'picture') {
              chooseStyle(value)
            }
          }}
        >
          <TabsList className="h-7 w-full">
            <TabsTrigger value="letters">
              {t('auto.components.repo.ProjectPeek.styleLetters', 'Letters')}
            </TabsTrigger>
            <TabsTrigger value="icon">
              {t('auto.components.settings.RepositoryIconPicker.b2d7fd2116', 'Icon')}
            </TabsTrigger>
            <TabsTrigger value="picture">
              {t('auto.components.repo.ProjectPeek.stylePicture', 'Picture')}
            </TabsTrigger>
          </TabsList>
          {/* Pictures keep their own colors, so color only applies to letters and icons. */}
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
          <TabsContent value="picture" className="mt-1">
            <PicturePanel
              repo={repo}
              remote={remote}
              loadingGitHub={actions.loadingGitHub}
              onUseGitHubAvatar={() => void actions.applyGitHubAvatar()}
              onSetIcon={setIcon}
            />
          </TabsContent>
        </Tabs>
      </div>
      <div className="flex items-center px-1.5 pb-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={actions.resetting || isDefault}
          onClick={() => void reset()}
        >
          <RotateCcw />
          {t('auto.components.repo.ProjectPeek.resetAppearance', 'Reset icon & color')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="muted-field-icon"
              size="icon-xs"
              className="ml-auto"
              aria-label={t(
                'auto.components.repo.ProjectPeek.openSettingsPage',
                'Open settings page'
              )}
              onClick={openIconSettings}
            >
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {t('auto.components.repo.ProjectPeek.openSettingsPage', 'Open settings page')}
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  )
}

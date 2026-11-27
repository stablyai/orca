import React, { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { avatarPackAvatar, parseBotAvatar } from '../../../../../shared/bot-avatar'
import {
  formatAvatarPackLabel,
  getAvatarPackCharacters,
  getAvatarPackIds,
  invalidateAvatarPackCatalogCache,
  resolveAvatarPackCharacterIndex,
  useAvatarPackCatalog
} from './avatar-pack-catalog'
import { AnimatedBotAvatar } from './AnimatedBotAvatar'
import type { AvatarAnimationState } from './avatar-pack-types'

export const AVATAR_PACK_PREVIEW_STATES: readonly AvatarAnimationState[] = [
  'idle',
  'think',
  'run',
  'read',
  'edit',
  'help',
  'done',
  'asleep',
  'dizzy'
]

export function formatAvatarAnimationStateLabel(state: AvatarAnimationState, t: Translate): string {
  switch (state) {
    case 'idle':
      return t('bots.avatarPacks.state.idle', 'Idle')
    case 'think':
      return t('bots.avatarPacks.state.think', 'Think')
    case 'run':
      return t('bots.avatarPacks.state.run', 'Run')
    case 'read':
      return t('bots.avatarPacks.state.read', 'Read')
    case 'edit':
      return t('bots.avatarPacks.state.edit', 'Edit')
    case 'help':
      return t('bots.avatarPacks.state.help', 'Help')
    case 'done':
      return t('bots.avatarPacks.state.done', 'Done')
    case 'asleep':
      return t('bots.avatarPacks.state.asleep', 'Asleep')
    case 'dizzy':
      return t('bots.avatarPacks.state.dizzy', 'Dizzy')
  }
}

export function BotPictureModeTabs({
  activeTab,
  onTabChange
}: {
  activeTab: 'animated' | 'classic'
  onTabChange: (tab: 'animated' | 'classic') => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex gap-1 border-b border-border/60 bg-muted/20 p-2">
      <button
        type="button"
        onClick={() => onTabChange('animated')}
        className={cn(
          'flex-1 cursor-pointer rounded-md py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
          activeTab === 'animated'
            ? 'bg-background font-semibold text-foreground shadow-xs'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        )}
      >
        {t('bots.avatarPacks.tabAnimated', 'Animated packs')}
      </button>
      <button
        type="button"
        onClick={() => onTabChange('classic')}
        className={cn(
          'flex-1 cursor-pointer rounded-md py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
          activeTab === 'classic'
            ? 'bg-background font-semibold text-foreground shadow-xs'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        )}
      >
        {t('bots.avatarPacks.tabClassic', 'Classic mascots')}
      </button>
    </div>
  )
}

export function ResetToClassicMascotButton({
  onReset
}: {
  onReset: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button type="button" size="xs" variant="ghost-muted" className="mt-1 w-full" onClick={onReset}>
      {t('bots.avatarPacks.resetToClassic', 'Use classic mascot')}
    </Button>
  )
}

export function AvatarPackCharacterPicker({
  currentAvatar,
  onSelect
}: {
  currentAvatar: string | null
  onSelect: (avatarString: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { catalog, loading } = useAvatarPackCatalog(true)
  const defaultPack = useAppStore((s) => s.settings?.avatarDefaultPack)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const parsedCurrent = parseBotAvatar(currentAvatar)
  const selectedPack = parsedCurrent?.kind === 'avatar-pack' ? parsedCurrent.pack : null
  const selectedRawChar = parsedCurrent?.kind === 'avatar-pack' ? parsedCurrent.charIndex : -1

  const [pickedPack, setPickedPack] = useState<string | null>(selectedPack)
  const [previewState, setPreviewState] = useState<AvatarAnimationState>('idle')

  const packIds = catalog ? getAvatarPackIds(catalog) : []
  const currentPack =
    (pickedPack && packIds.includes(pickedPack) ? pickedPack : null) ??
    (selectedPack && packIds.includes(selectedPack) ? selectedPack : null) ??
    (defaultPack && packIds.includes(defaultPack) ? defaultPack : null) ??
    packIds[0] ??
    ''

  const charKeys = catalog && currentPack ? getAvatarPackCharacters(catalog, currentPack) : []
  const selectedChar =
    catalog && selectedPack === currentPack && selectedRawChar >= 0
      ? resolveAvatarPackCharacterIndex(catalog, currentPack, selectedRawChar)
      : selectedRawChar

  const handleChooseFolder = async (): Promise<void> => {
    const picked = await window.api?.shell?.pickDirectory?.({})
    if (!picked) {
      return
    }
    await updateSettings({ avatarPacksDir: picked, avatarPacksEnabled: true })
    invalidateAvatarPackCatalogCache()
  }

  const handleOpenSettings = (): void => {
    const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
    openSettingsTarget({ pane: 'bots', repoId: null })
    openSettingsPage()
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <LoadingSpinner className="size-4" />
      </div>
    )
  }

  if (!catalog || packIds.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-center">
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">
            {t('bots.avatarPacks.emptyTitle', 'No animated avatar packs found')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'bots.avatarPacks.emptyDescription',
              'Choose a folder containing catalog_index.json, or place packs in ~/.orca/avatar-packs.'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void handleChooseFolder()}
          >
            <FolderOpen />
            {t('bots.avatarPacks.chooseFolder', 'Choose folder')}
          </Button>
          <Button type="button" variant="ghost-muted" size="xs" onClick={handleOpenSettings}>
            {t('bots.avatarPacks.openSettings', 'Bot settings')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-sleek">
        {packIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setPickedPack(id)}
            className={cn(
              'shrink-0 cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              currentPack === id
                ? 'bg-accent font-semibold text-accent-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            {formatAvatarPackLabel(catalog, id)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-1.5 text-2xs text-muted-foreground">
        <span>{t('bots.avatarPacks.previewAction', 'Preview action')}</span>
        <div className="flex flex-wrap gap-1">
          {AVATAR_PACK_PREVIEW_STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setPreviewState(s)}
              className={cn(
                'cursor-pointer rounded-sm px-1.5 py-0.5 text-3xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                previewState === s
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'bg-muted/50 text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              {formatAvatarAnimationStateLabel(s, t)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid max-h-56 grid-cols-4 gap-2 overflow-y-auto pr-1 scrollbar-sleek">
        {charKeys.map((k) => {
          const charIndex = Number.parseInt(k, 10)
          const isSelected = selectedPack === currentPack && selectedChar === charIndex
          return (
            <button
              key={k}
              type="button"
              onClick={() => onSelect(avatarPackAvatar(currentPack, charIndex))}
              className={cn(
                'group relative flex cursor-pointer flex-col items-center justify-center rounded-lg border p-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected
                  ? 'border-foreground/35 bg-accent shadow-xs ring-1 ring-ring'
                  : 'border-border/60 bg-muted/20 hover:border-border hover:bg-accent/40'
              )}
            >
              <div className="flex size-12 items-center justify-center overflow-hidden rounded-md">
                <AnimatedBotAvatar
                  pack={currentPack}
                  charIndex={charIndex}
                  state={previewState}
                  className="size-11"
                />
              </div>
              <span className="mt-1 font-mono text-3xs text-muted-foreground group-hover:text-foreground">
                #{charIndex}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

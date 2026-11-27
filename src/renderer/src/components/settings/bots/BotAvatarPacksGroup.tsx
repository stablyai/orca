import React, { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  formatAvatarPackLabel,
  getAvatarPackIds,
  invalidateAvatarPackCatalogCache,
  resolveAvatarPackId,
  useAvatarPackCatalog
} from '@/components/bots/avatar-packs/avatar-pack-catalog'
import { AnimatedBotAvatar } from '@/components/bots/avatar-packs/AnimatedBotAvatar'
import {
  AVATAR_PACK_PREVIEW_STATES,
  formatAvatarAnimationStateLabel
} from '@/components/bots/avatar-packs/AvatarPackCharacterPicker'
import type { AvatarAnimationState } from '@/components/bots/avatar-packs/avatar-pack-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'

async function pickAvatarPacksFolderAndResetBlur(
  skipNextBlurRef: { current: boolean },
  onPicked: (picked: string) => Promise<void>
): Promise<void> {
  try {
    const picked = await window.api?.shell?.pickDirectory?.({})
    if (picked) {
      await onPicked(picked)
    }
  } finally {
    skipNextBlurRef.current = false
  }
}

export function BotAvatarPacksGroup({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const pathInputId = useId()
  const enabled = settings.avatarPacksEnabled ?? false
  const savedCustomPath = settings.avatarPacksDir ?? ''
  const [previewState, setPreviewState] = useState<AvatarAnimationState>('idle')
  const [customPath, setCustomPath] = useState(savedCustomPath)
  const draftRef = useRef(savedCustomPath)
  const skipNextBlurRef = useRef(false)

  const { catalog, loading } = useAvatarPackCatalog(enabled)

  useEffect(() => {
    setCustomPath(savedCustomPath)
    draftRef.current = savedCustomPath
  }, [savedCustomPath])

  const packIds = catalog ? getAvatarPackIds(catalog) : []
  const effectivePack =
    (catalog ? resolveAvatarPackId(catalog, settings.avatarDefaultPack) : null) ??
    settings.avatarDefaultPack ??
    packIds[0] ??
    ''

  const commitPacksDir = async (rawPath: string): Promise<void> => {
    const trimmed = rawPath.trim()
    setCustomPath(trimmed)
    draftRef.current = trimmed
    const nextValue = trimmed || undefined
    if ((savedCustomPath || undefined) !== nextValue) {
      await updateSettings({ avatarPacksDir: nextValue })
    }
    invalidateAvatarPackCatalogCache()
  }

  const handleBrowse = (): Promise<void> =>
    pickAvatarPacksFolderAndResetBlur(skipNextBlurRef, commitPacksDir)

  const stateOptions = AVATAR_PACK_PREVIEW_STATES.map((s) => ({
    value: s,
    label: formatAvatarAnimationStateLabel(s, t)
  }))

  return (
    <SettingsGroup
      title={t('settings.bots.avatarPacks.title', 'Animated avatar packs')}
      description={t(
        'settings.bots.avatarPacks.description',
        'Replace static bot icons with animated vector characters that follow each bot’s live activity.'
      )}
    >
      <SettingsSwitchRow
        label={t('settings.bots.avatarPacks.enable', 'Enable animated avatar packs')}
        description={t(
          'settings.bots.avatarPacks.enableDescription',
          'Animate bot icons as agents read, edit, run commands, think, or sleep.'
        )}
        checked={enabled}
        onChange={() => void updateSettings({ avatarPacksEnabled: !enabled })}
      />

      {enabled ? (
        <>
          <SettingsRow
            htmlFor={pathInputId}
            label={t('settings.bots.avatarPacks.packsLocation', 'Avatar packs folder')}
            description={t(
              'settings.bots.avatarPacks.packsLocationDescription',
              'Folder containing catalog_index.json and avatar packs. Defaults to ~/.orca/avatar-packs.'
            )}
            control={
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={pathInputId}
                  variant="code"
                  density="compact"
                  value={customPath}
                  placeholder={t(
                    'settings.bots.avatarPacks.packsPlaceholder',
                    '~/.orca/avatar-packs'
                  )}
                  onChange={(e) => {
                    draftRef.current = e.target.value
                    setCustomPath(e.target.value)
                  }}
                  onBlur={() => {
                    if (skipNextBlurRef.current) {
                      skipNextBlurRef.current = false
                      return
                    }
                    if (draftRef.current.trim() !== savedCustomPath) {
                      void commitPacksDir(draftRef.current)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (isImeCompositionKeyDown(e)) {
                      return
                    }
                    if (e.key === 'Enter') {
                      skipNextBlurRef.current = true
                      void commitPacksDir(draftRef.current)
                      e.currentTarget.blur()
                    } else if (e.key === 'Escape') {
                      skipNextBlurRef.current = true
                      draftRef.current = savedCustomPath
                      setCustomPath(savedCustomPath)
                      e.currentTarget.blur()
                    }
                  }}
                  className="w-60"
                />
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onPointerDown={() => {
                    skipNextBlurRef.current = true
                  }}
                  onClick={() => void handleBrowse()}
                >
                  <FolderOpen />
                  {t('settings.bots.avatarPacks.browse', 'Browse')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onPointerDown={() => {
                    skipNextBlurRef.current = true
                  }}
                  onClick={() => void commitPacksDir(draftRef.current)}
                >
                  {t('settings.bots.avatarPacks.save', 'Save')}
                </Button>
              </div>
            }
          />

          {!loading && packIds.length === 0 ? (
            <div
              data-settings-row=""
              className="flex flex-wrap items-center justify-between gap-4 py-3"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {t('settings.bots.avatarPacks.emptyTitle', 'No avatar packs found')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'settings.bots.avatarPacks.emptyDescription',
                    'Select a folder with catalog_index.json to load animated avatar packs.'
                  )}
                </p>
              </div>
              <Button type="button" variant="outline" size="xs" onClick={() => void handleBrowse()}>
                <FolderOpen />
                {t('settings.bots.avatarPacks.chooseFolder', 'Choose folder')}
              </Button>
            </div>
          ) : null}

          {packIds.length > 0 ? (
            <>
              <SettingsRow
                label={t('settings.bots.avatarPacks.defaultPack', 'Default avatar pack')}
                description={t(
                  'settings.bots.avatarPacks.defaultPackDescription',
                  'Used for bots without an individual animated character.'
                )}
                control={
                  <Select
                    value={effectivePack}
                    onValueChange={(val) => void updateSettings({ avatarDefaultPack: val })}
                  >
                    <SelectTrigger
                      size="xs"
                      aria-label={t('settings.bots.avatarPacks.defaultPack', 'Default avatar pack')}
                      className="min-w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {packIds.map((packId) => (
                        <SelectItem key={packId} value={packId}>
                          {formatAvatarPackLabel(catalog, packId)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              />

              <div data-settings-row="" className="space-y-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {t('settings.bots.avatarPacks.previewTitle', 'Action preview')}
                  </span>
                  <SettingsSegmentedControl
                    value={previewState}
                    onChange={setPreviewState}
                    options={stateOptions}
                    size="sm"
                    wrap
                    ariaLabel={t('settings.bots.avatarPacks.previewTitle', 'Action preview')}
                  />
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
                  <div className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
                    <AnimatedBotAvatar
                      pack={effectivePack}
                      charIndex={0}
                      state={previewState}
                      className="size-12"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'settings.bots.avatarPacks.previewDescription',
                      'Previewing {{pack}} in {{state}} state. Bots switch states automatically as their agents work.',
                      {
                        pack: formatAvatarPackLabel(catalog, effectivePack),
                        state: formatAvatarAnimationStateLabel(previewState, t).toLowerCase()
                      }
                    )}
                  </p>
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </SettingsGroup>
  )
}

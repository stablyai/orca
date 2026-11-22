import { useState } from 'react'
import { toast } from 'sonner'
import {
  normalizeNativeChatAppearanceSettings,
  type NativeChatAppearanceSettings
} from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { useAppStore } from '../../../../store/index'
import { writeNativeChatAppearance } from '../../../native-chat/appearance/native-chat-appearance-write'
import { useNativeChatBackgroundUrl } from '../../../native-chat/appearance/use-native-chat-background-url'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { Slider } from '../../../ui/slider'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { getChatBackgroundEntriesByKey } from './chat-appearance-search'

type ChatBackgroundControlsProps = {
  appearance: Required<NativeChatAppearanceSettings>
  onChange: (updates: NativeChatAppearanceSettings) => Promise<boolean>
  /** The picture lives in this computer's app data, so only the desktop app can pick one. */
  showImageControls: boolean
  forceVisiblePrimary?: boolean
}

export function deleteNativeChatBackground(fileName: string | undefined): void {
  if (!fileName) {
    return
  }
  window.api.nativeChatBackground
    ?.delete(fileName)
    .catch((error) => console.error('Failed to delete chat background image:', error))
}

type Persist = (updates: Partial<GlobalSettings>) => Promise<void>

/** Swaps the saved picture and deletes the file it replaced, only once the setting is saved. */
async function replaceNativeChatBackground(
  fileName: string | undefined,
  persist: Persist
): Promise<boolean> {
  let replaced: string | undefined
  const saved = await writeNativeChatAppearance((current) => {
    replaced = current?.backgroundImage
    return normalizeNativeChatAppearanceSettings({ ...current, backgroundImage: fileName })
  }, persist)
  if (saved && replaced !== fileName) {
    deleteNativeChatBackground(replaced)
  }
  return saved
}

/** Imports a picked image and saves it; resolves false when the image could not be used. */
async function chooseNativeChatBackground(persist: Persist): Promise<boolean> {
  try {
    const fileName = await window.api.nativeChatBackground?.import()
    if (!fileName) {
      return true
    }
    if (await replaceNativeChatBackground(fileName, persist)) {
      return true
    }
    deleteNativeChatBackground(fileName)
    return false
  } catch (error) {
    console.error('Failed to set chat background image:', error)
    return false
  }
}

async function whileBusy(
  setBusy: (busy: boolean) => void,
  task: () => Promise<boolean>,
  onFailed: () => void
): Promise<void> {
  setBusy(true)
  const ok = await task()
  setBusy(false)
  if (!ok) {
    onFailed()
  }
}

export function AppearanceChatBackgroundControls({
  appearance,
  onChange,
  showImageControls,
  forceVisiblePrimary
}: ChatBackgroundControlsProps): React.JSX.Element {
  const t = useTranslate()
  const entries = getChatBackgroundEntriesByKey()
  const { backgroundImage } = appearance
  const previewUrl = useNativeChatBackgroundUrl(showImageControls ? backgroundImage : '')
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const [busy, setBusy] = useState(false)
  const failed = (): void => {
    toast.error(t('settings.appearance.chat.backgroundImageFailed', 'Could not use that image.'))
  }

  const choose = (): Promise<void> =>
    whileBusy(setBusy, () => chooseNativeChatBackground(updateSettingsOrThrow), failed)
  const remove = (): Promise<void> =>
    whileBusy(setBusy, () => replaceNativeChatBackground(undefined, updateSettingsOrThrow), failed)

  const glassToggle = (
    <SearchableSetting
      id={entries.glassMessages.targetSectionId}
      {...entries.glassMessages}
      forceVisible={forceVisiblePrimary}
    >
      <SettingsSwitchRow
        label={entries.glassMessages.title}
        checked={appearance.glassMessages}
        onChange={() => void onChange({ glassMessages: !appearance.glassMessages })}
      />
    </SearchableSetting>
  )
  if (!showImageControls) {
    return glassToggle
  }

  return (
    <>
      <SearchableSetting
        id={entries.backgroundImage.targetSectionId}
        {...entries.backgroundImage}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={entries.backgroundImage.title}
          control={
            <div className="flex items-center gap-2">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt=""
                  className="h-6 w-10 rounded-sm border border-border object-cover"
                />
              ) : null}
              {backgroundImage ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
                  {t('settings.appearance.chat.backgroundImageRemove', 'Remove')}
                </Button>
              ) : null}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void choose()}>
                {backgroundImage
                  ? t('settings.appearance.chat.backgroundImageChange', 'Change…')
                  : t('settings.appearance.chat.backgroundImageChoose', 'Choose…')}
              </Button>
            </div>
          }
        />
      </SearchableSetting>
      <SearchableSetting
        id={entries.backgroundVisibility.targetSectionId}
        {...entries.backgroundVisibility}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={entries.backgroundVisibility.title}
          control={
            <ChatPercentSlider
              value={appearance.backgroundVisibility}
              min={10}
              label={entries.backgroundVisibility.title}
              disabled={!previewUrl}
              onCommit={(backgroundVisibility) =>
                writeNativeChatAppearance(
                  (current) =>
                    normalizeNativeChatAppearanceSettings({ ...current, backgroundVisibility }),
                  updateSettingsOrThrow
                )
              }
            />
          }
        />
      </SearchableSetting>
      {glassToggle}
    </>
  )
}

function ChatPercentSlider({
  value,
  min = 0,
  label,
  disabled = false,
  onCommit
}: {
  value: number
  min?: number
  label: string
  disabled?: boolean
  /** Resolves false when the value was not saved, so the thumb returns to the saved one. */
  onCommit: (value: number) => Promise<boolean>
}): React.JSX.Element {
  const [draft, setDraft] = useState({ saved: value, value })
  // Keep the thumb mounted so committed keyboard changes retain focus.
  if (draft.saved !== value) {
    setDraft({ saved: value, value })
  }
  return (
    <div className="flex items-center gap-2">
      <div className="w-40">
        <Slider
          disabled={disabled}
          min={min}
          max={100}
          step={1}
          value={[draft.value]}
          thumbLabels={[label]}
          onValueChange={([next]) => setDraft({ saved: value, value: next })}
          onValueCommit={([next]) =>
            void onCommit(next).then((saved) => {
              // Only while the thumb still shows the value that failed; a newer drag keeps its own.
              if (!saved) {
                setDraft((current) => (current.value === next ? { saved: value, value } : current))
              }
            })
          }
        />
      </div>
      <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
        {draft.value}%
      </span>
    </div>
  )
}

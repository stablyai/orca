import type React from 'react'
import { useLayoutEffect, useState } from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppBackgroundPickRejection } from '../../../../shared/app-background-types'
import {
  MAX_APP_BACKGROUND_BLUR_PX,
  MIN_APP_BACKGROUND_BLUR_PX,
  MIN_APP_BACKGROUND_PANEL_OPACITY,
  normalizeAppBackgroundImageId,
  type AppBackgroundScope
} from '../../../../shared/app-background-settings'
import { useAppStore } from '../../store'
import {
  hasUnappliedAppBackgroundChanges,
  readAppBackgroundDraftValues,
  resolveAppBackgroundDraftImage,
  type AppBackgroundApplyResult,
  type AppBackgroundDraft
} from '../../store/slices/app-background-draft'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Slider } from '../ui/slider'
import { useAppBackgroundBlobState } from '../app-background/AppBackgroundLayer'
import { AppBackgroundPreview } from './AppBackgroundPreview'
import { SettingsBadge, SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'

type AppBackgroundApplyFailure = Extract<AppBackgroundApplyResult, { ok: false }>['reason']

export function describeAppBackgroundPickRejection(reason: AppBackgroundPickRejection): string {
  switch (reason) {
    case 'tooLarge':
      return translate(
        'settings.appearance.background.error.tooLarge',
        'That image is larger than 20 MB. Choose a smaller file.'
      )
    case 'unsupportedType':
      return translate(
        'settings.appearance.background.error.unsupportedType',
        'That file is not a supported image. Use PNG, JPEG, GIF, or WebP.'
      )
    case 'unreadable':
      return translate(
        'settings.appearance.background.error.unreadable',
        'Orca could not read that file.'
      )
    case 'saveFailed':
      return translate(
        'settings.appearance.background.error.pickSaveFailed',
        'Orca could not copy that image. Try again.'
      )
  }
}

/** Null for outcomes the user does not need to hear about (no draft, already applying). */
export function describeAppBackgroundApplyFailure(
  reason: AppBackgroundApplyFailure
): string | null {
  switch (reason) {
    case 'noDraft':
    case 'busy':
      return null
    case 'invalidId':
    case 'stagingMissing':
      return translate(
        'settings.appearance.background.error.stagingMissing',
        'The selected image is no longer available. Choose it again.'
      )
    case 'saveFailed':
      return translate(
        'settings.appearance.background.error.applyFailed',
        'Orca could not save the background settings. Try again.'
      )
  }
}

function resolveImageStatus(
  draft: AppBackgroundDraft | null,
  savedImageId: string | null,
  imageMissing: boolean
): string {
  if (imageMissing) {
    return translate(
      'settings.appearance.background.imageMissing',
      'The background image could not be loaded. Choose another image or remove it.'
    )
  }
  if (draft?.image.kind === 'staged') {
    return translate('settings.appearance.background.imageStaged', 'New image selected.')
  }
  if (draft?.image.kind === 'remove') {
    return translate('settings.appearance.background.imageRemoved', 'Image will be removed.')
  }
  return savedImageId
    ? translate('settings.appearance.background.imageSet', 'Custom image in use.')
    : translate('settings.appearance.background.imageNone', 'No image selected.')
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

type BackgroundSliderRowProps = {
  label: string
  description: string
  value: number
  min: number
  max: number
  step: number
  valueText: string
  disabled: boolean
  onChange: (value: number) => void
}

function BackgroundSliderRow({
  label,
  description,
  value,
  min,
  max,
  step,
  valueText,
  disabled,
  onChange
}: BackgroundSliderRowProps): React.JSX.Element {
  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <div className="flex items-center gap-2">
          <div className="w-40">
            <Slider
              min={min}
              max={max}
              step={step}
              value={[value]}
              disabled={disabled}
              thumbLabels={[label]}
              thumbValueLabels={[valueText]}
              onValueChange={([next]) => onChange(Math.round(next * 100) / 100)}
            />
          </div>
          <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
            {valueText}
          </span>
        </div>
      }
    />
  )
}

type AppearanceBackgroundSectionProps = {
  settings: GlobalSettings
}

export function AppearanceBackgroundSection({
  settings
}: AppearanceBackgroundSectionProps): React.JSX.Element {
  const draft = useAppStore((state) => state.appBackgroundDraft) ?? null
  const applying = useAppStore((state) => state.appBackgroundDraftApplying) === true
  const setDraft = useAppStore((state) => state.setAppBackgroundDraft)
  const stageImage = useAppStore((state) => state.stageAppBackgroundDraftImage)
  const removeImage = useAppStore((state) => state.removeAppBackgroundDraftImage)
  const applyDraft = useAppStore((state) => state.applyAppBackgroundDraft)
  const discardDraft = useAppStore((state) => state.discardAppBackgroundDraft)
  const syncDraft = useAppStore((state) => state.syncAppBackgroundDraftWithSettings)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Why: other windows and the Terminal section write these settings too; keep untouched draft fields current.
  useLayoutEffect(() => {
    syncDraft()
  }, [
    syncDraft,
    settings.appBackgroundImageId,
    settings.appBackgroundScope,
    settings.appBackgroundImageOpacity,
    settings.appBackgroundBlur,
    settings.appBackgroundPanelOpacity,
    settings.terminalBackgroundOpacity
  ])

  // Why: no draft until the first edit, so the controls mirror the applied settings until then.
  const values = draft ?? readAppBackgroundDraftValues(settings)
  const savedImageId = draft
    ? draft.snapshot.imageId
    : normalizeAppBackgroundImageId(settings.appBackgroundImageId)
  const image = draft
    ? resolveAppBackgroundDraftImage(draft)
    : savedImageId
      ? { id: savedImageId, staging: false }
      : null
  const hasChanges = hasUnappliedAppBackgroundChanges(draft)
  const imageState = useAppBackgroundBlobState(image)
  const imageMissing = imageState?.status === 'missing'

  const handlePick = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const result = await window.api.appBackground.pick()
      // Why: undefined means the bridge is missing (web fallback proxy); the section is hidden there anyway.
      if (result?.status === 'picked') {
        stageImage(result.stagingId)
      } else if (result?.status === 'rejected') {
        setError(describeAppBackgroundPickRejection(result.reason))
      }
    } catch (err) {
      console.error('Failed to pick background image:', err)
      setError(describeAppBackgroundPickRejection('unreadable'))
    } finally {
      setPicking(false)
    }
  }

  const handleApply = async (): Promise<void> => {
    setError(null)
    const result = await applyDraft()
    if (!result.ok) {
      setError(describeAppBackgroundApplyFailure(result.reason))
    }
  }

  const handleDiscard = (): void => {
    setError(null)
    discardDraft()
  }

  const scopeOptions: { value: AppBackgroundScope; label: string; disabled: boolean }[] = [
    {
      value: 'window',
      label: translate('settings.appearance.background.scope.window', 'Entire window'),
      disabled: applying
    },
    {
      value: 'workspace',
      label: translate('settings.appearance.background.scope.workspace', 'Workspace only'),
      disabled: applying
    }
  ]

  return (
    <div className="space-y-1 pt-2" data-testid="appearance-background-section">
      {/* Why: mirror the live app, which keeps panels opaque until the image actually loads. */}
      <AppBackgroundPreview
        image={imageState?.status === 'loaded' ? image : null}
        values={values}
      />

      <SettingsRow
        label={translate('settings.appearance.background.image', 'Image')}
        description={resolveImageStatus(draft, savedImageId, imageMissing)}
        control={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={picking || applying}
              onClick={() => void handlePick()}
            >
              {picking ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus />}
              {translate('settings.appearance.background.chooseImage', 'Choose Image…')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!image || applying}
              onClick={() => removeImage()}
            >
              {translate('settings.appearance.background.removeImage', 'Remove')}
            </Button>
          </div>
        }
      />
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <SettingsRow
        label={translate('settings.appearance.background.scopeLabel', 'Show Image In')}
        description={translate(
          'settings.appearance.background.scopeDescription',
          'Cover the whole window, or only the workspace between the sidebars.'
        )}
        control={
          <SettingsSegmentedControl
            value={values.scope}
            onChange={(scope) => setDraft({ scope })}
            options={scopeOptions}
            ariaLabel={translate('settings.appearance.background.scopeLabel', 'Show Image In')}
            size="sm"
          />
        }
      />
      <BackgroundSliderRow
        label={translate('settings.appearance.background.imageOpacity', 'Image Opacity')}
        description={translate(
          'settings.appearance.background.imageOpacityDescription',
          'How strongly the image shows through.'
        )}
        value={values.imageOpacity}
        min={0}
        max={1}
        step={0.05}
        disabled={applying}
        valueText={formatPercent(values.imageOpacity)}
        onChange={(imageOpacity) => setDraft({ imageOpacity })}
      />
      <BackgroundSliderRow
        label={translate('settings.appearance.background.blur', 'Image Blur')}
        description={translate(
          'settings.appearance.background.blurDescription',
          'Soften the image so text stays easy to read.'
        )}
        value={values.blur}
        min={MIN_APP_BACKGROUND_BLUR_PX}
        max={MAX_APP_BACKGROUND_BLUR_PX}
        step={1}
        disabled={applying}
        valueText={`${values.blur}px`}
        onChange={(blur) => setDraft({ blur })}
      />
      <BackgroundSliderRow
        label={translate('settings.appearance.background.panelOpacity', 'Panel Opacity')}
        description={translate(
          'settings.appearance.background.panelOpacityDescription',
          'Opacity of the title bar, sidebars, and tab bar while an image is set.'
        )}
        value={values.panelOpacity}
        min={MIN_APP_BACKGROUND_PANEL_OPACITY}
        max={1}
        step={0.05}
        disabled={applying}
        valueText={formatPercent(values.panelOpacity)}
        onChange={(panelOpacity) => setDraft({ panelOpacity })}
      />
      <BackgroundSliderRow
        label={translate(
          'settings.appearance.background.terminalOpacity',
          'Terminal Background Opacity'
        )}
        description={translate(
          'settings.appearance.background.terminalOpacityDescription',
          'Same as the terminal opacity setting; lower it to see the image behind terminals.'
        )}
        value={values.terminalBackgroundOpacity}
        min={0}
        max={1}
        step={0.05}
        disabled={applying}
        valueText={formatPercent(values.terminalBackgroundOpacity)}
        onChange={(terminalBackgroundOpacity) => setDraft({ terminalBackgroundOpacity })}
      />

      <div className="flex items-center justify-end gap-2 pt-2">
        {hasChanges ? (
          <SettingsBadge tone="accent" className="mr-auto">
            {translate('settings.appearance.background.unapplied', 'Unapplied changes')}
          </SettingsBadge>
        ) : null}
        <Button variant="ghost" size="sm" disabled={!draft || applying} onClick={handleDiscard}>
          {translate('settings.appearance.background.discard', 'Discard')}
        </Button>
        <Button size="sm" disabled={!hasChanges || applying} onClick={() => void handleApply()}>
          {applying ? <Loader2 className="size-4 animate-spin" /> : null}
          {translate('settings.appearance.background.apply', 'Apply')}
        </Button>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import type React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import classicIconUrl from '../../../../../../resources/icon.png?url'
import watercolorIconUrl from '../../../../../../resources/app-icons/orca-watercolor.png?url'
import blueIconUrl from '../../../../../../resources/app-icons/orca-blue.png?url'
import {
  APP_ICON_OPTIONS,
  CUSTOM_APP_ICON_ID,
  CUSTOM_APP_ICON_MAX_BYTES,
  CUSTOM_APP_ICON_MAX_SIDE,
  CUSTOM_APP_ICON_MIN_SIDE,
  DEFAULT_APP_ICON_ID,
  normalizeAppIconId,
  type AppIconId,
  type BuiltInAppIconId,
  type CustomAppIconImportFailureCode
} from '../../../../../shared/app-icon'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/lib/web-client-location'

const APP_ICON_URLS = {
  classic: classicIconUrl,
  watercolor: watercolorIconUrl,
  blue: blueIconUrl
} satisfies Record<BuiltInAppIconId, string>

const BUILT_IN_APP_ICON_IDS: readonly AppIconId[] = APP_ICON_OPTIONS.map((option) => option.id)

type AppIconSelectorProps = {
  value: AppIconId
  onChange: (value: AppIconId) => void
}

function getOffsetIcon(options: readonly AppIconId[], value: AppIconId, offset: -1 | 1): AppIconId {
  const index = Math.max(options.indexOf(value), 0)
  return options[(index + offset + options.length) % options.length] ?? DEFAULT_APP_ICON_ID
}

function importFailureText(t: Translate, code: CustomAppIconImportFailureCode): string {
  switch (code) {
    case 'unsupportedFormat':
      return t(
        'settings.appearance.appIcon.importErrors.unsupportedFormat',
        'Unsupported image. Pick a PNG or JPEG file.'
      )
    case 'unreadable':
      return t(
        'settings.appearance.appIcon.importErrors.unreadable',
        'Could not read the selected file.'
      )
    case 'tooLarge':
      return t(
        'settings.appearance.appIcon.importErrors.tooLarge',
        'Image is larger than {{max}} MB.',
        { max: CUSTOM_APP_ICON_MAX_BYTES / (1024 * 1024) }
      )
    case 'notSquare':
      return t('settings.appearance.appIcon.importErrors.notSquare', 'App icons must be square.')
    case 'tooSmall':
      return t(
        'settings.appearance.appIcon.importErrors.tooSmall',
        'Image must be at least {{min}}×{{min}} pixels.',
        { min: CUSTOM_APP_ICON_MIN_SIDE }
      )
    case 'tooBig':
      return t(
        'settings.appearance.appIcon.importErrors.tooBig',
        'Image must be at most {{max}}×{{max}} pixels.',
        { max: CUSTOM_APP_ICON_MAX_SIDE }
      )
    case 'undecodable':
      return t(
        'settings.appearance.appIcon.importErrors.undecodable',
        'Could not decode the selected image.'
      )
    case 'saveFailed':
      return t(
        'settings.appearance.appIcon.importErrors.saveFailed',
        'Could not save the custom icon.'
      )
  }
}

type IconCycleButtonProps = {
  label: string
  onClick: () => void
  children: React.ReactNode
}

function IconCycleButton({ label, onClick, children }: IconCycleButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function AppIconSelector({ value, onChange }: AppIconSelectorProps): React.JSX.Element {
  const t = useTranslate()
  // Web clients have no local Dock or taskbar to apply an imported file to.
  const canUseCustomIcon = !isWebClientLocation()
  const [customPreviewUrl, setCustomPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!canUseCustomIcon) {
      return
    }
    let cancelled = false
    void window.api.appIcon
      .readCustomPreview()
      .then((url) => {
        if (!cancelled) {
          setCustomPreviewUrl(url)
        }
      })
      .catch((error: unknown) => console.warn('[app-icon] failed to read custom icon:', error))
    return () => {
      cancelled = true
    }
  }, [canUseCustomIcon])

  const options: readonly AppIconId[] = customPreviewUrl
    ? [...BUILT_IN_APP_ICON_IDS, CUSTOM_APP_ICON_ID]
    : BUILT_IN_APP_ICON_IDS
  const normalized = normalizeAppIconId(value)
  // Main falls back to Classic when the imported file is gone, so the preview does too.
  const builtInSelection = normalized === CUSTOM_APP_ICON_ID ? DEFAULT_APP_ICON_ID : normalized
  const showsCustom = normalized === CUSTOM_APP_ICON_ID && customPreviewUrl !== null
  const selected = showsCustom ? CUSTOM_APP_ICON_ID : builtInSelection
  const selectedUrl = showsCustom ? customPreviewUrl : APP_ICON_URLS[builtInSelection]

  const importCustomIcon = async (): Promise<void> => {
    try {
      const result = await window.api.appIcon.importCustom()
      if (!result) {
        return
      }
      if (!result.ok) {
        toast.error(importFailureText(t, result.code))
        return
      }
      setCustomPreviewUrl(result.previewDataUrl)
      onChange(CUSTOM_APP_ICON_ID)
    } catch (error) {
      console.warn('[app-icon] custom icon import failed:', error)
      toast.error(importFailureText(t, 'saveFailed'))
    }
  }

  const removeCustomIcon = async (): Promise<void> => {
    if (selected === CUSTOM_APP_ICON_ID) {
      onChange(DEFAULT_APP_ICON_ID)
    }
    setCustomPreviewUrl(null)
    await window.api.appIcon
      .removeCustom()
      .catch((error: unknown) => console.warn('[app-icon] failed to remove custom icon:', error))
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center justify-center gap-2">
        <IconCycleButton
          label={t('auto.components.settings.AppIconSelector.5f5142a62a', 'Previous icon')}
          onClick={() => onChange(getOffsetIcon(options, selected, -1))}
        >
          <ChevronLeft className="size-4" />
        </IconCycleButton>
        <img
          src={selectedUrl}
          alt={t('auto.components.settings.AppIconSelector.415fa76f64', 'Selected app icon')}
          className="size-24 rounded-2xl object-contain"
        />
        <IconCycleButton
          label={t('auto.components.settings.AppIconSelector.d5a112dc9b', 'Next icon')}
          onClick={() => onChange(getOffsetIcon(options, selected, 1))}
        >
          <ChevronRight className="size-4" />
        </IconCycleButton>
      </div>
      {canUseCustomIcon ? (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void importCustomIcon()}>
            {customPreviewUrl
              ? t('settings.appearance.appIcon.replaceCustom', 'Replace custom icon…')
              : t('settings.appearance.appIcon.importCustom', 'Custom…')}
          </Button>
          {customPreviewUrl ? (
            <Button variant="ghost" size="sm" onClick={() => void removeCustomIcon()}>
              {t('settings.appearance.appIcon.removeCustom', 'Remove custom icon')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

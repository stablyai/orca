import type React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import classicIconUrl from '../../../../../resources/icon.png?url'
import watercolorIconUrl from '../../../../../resources/app-icons/orca-watercolor.png?url'
import blueIconUrl from '../../../../../resources/app-icons/orca-blue.png?url'
import { APP_ICON_OPTIONS, normalizeAppIconId, type AppIconId } from '../../../../shared/app-icon'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

const APP_ICON_URLS = {
  classic: classicIconUrl,
  watercolor: watercolorIconUrl,
  blue: blueIconUrl
} satisfies Record<AppIconId, string>

type AppIconSelectorProps = {
  value: AppIconId
  onChange: (value: AppIconId) => void
}

function getAppIconOptionIndex(value: AppIconId): number {
  const index = APP_ICON_OPTIONS.findIndex((option) => option.id === value)
  return Math.max(index, 0)
}

function getOffsetIcon(value: AppIconId, offset: -1 | 1): AppIconId {
  const index = getAppIconOptionIndex(value)
  const next = (index + offset + APP_ICON_OPTIONS.length) % APP_ICON_OPTIONS.length
  return APP_ICON_OPTIONS[next].id
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
  const selected = normalizeAppIconId(value)

  return (
    <div className="flex items-center justify-center gap-2">
      <IconCycleButton label={translate("auto.components.settings.AppIconSelector.5f5142a62a", "Previous icon")} onClick={() => onChange(getOffsetIcon(selected, -1))}>
        <ChevronLeft className="size-4" />
      </IconCycleButton>
      <img
        src={APP_ICON_URLS[selected]}
        alt={translate("auto.components.settings.AppIconSelector.415fa76f64", "Selected app icon")}
        className="size-24 rounded-2xl object-contain"
      />
      <IconCycleButton label={translate("auto.components.settings.AppIconSelector.d5a112dc9b", "Next icon")} onClick={() => onChange(getOffsetIcon(selected, 1))}>
        <ChevronRight className="size-4" />
      </IconCycleButton>
    </div>
  )
}

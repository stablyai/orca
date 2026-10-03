import React, { useState } from 'react'
import { AppWindowMac, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import type { OpenInAppIcon, OpenInAppIconId } from '../../../../shared/open-in-app-icons'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { cn } from '@/lib/utils'
import { getOpenInAppIconOptions } from '@/lib/open-in-app-icon-set'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

function OpenInAppIconGrid({
  selectedId,
  onSelect
}: {
  selectedId: OpenInAppIconId | null
  onSelect: (id: OpenInAppIconId) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-8 gap-1">
      {getOpenInAppIconOptions().map((option) => (
        <Tooltip key={option.id}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={selectedId === option.id ? 'secondary' : 'ghost'}
              size="icon-xs"
              className="size-8"
              onClick={() => onSelect(option.id)}
              aria-label={translate(
                'auto.components.settings.OpenInAppIconPicker.useIcon',
                'Use {{value0}} icon',
                { value0: option.label }
              )}
              aria-pressed={selectedId === option.id}
            >
              <option.icon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {option.label}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

export function OpenInAppIconPicker({
  application,
  onSelect
}: {
  application: Pick<OpenInApplication, 'command' | 'icon'>
  onSelect: (icon: OpenInAppIcon | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const mountedRef = useMountedRef()
  const selectedId = application.icon?.type === 'bundled' ? application.icon.id : null
  // Why: a real app icon is its own tile, so it replaces the frame instead of
  // sitting inside it. A glyph still needs the frame to read as a control.
  const hasAppIcon = application.icon?.type === 'image'

  const select = (icon: OpenInAppIcon | null): void => {
    onSelect(icon)
    setOpen(false)
  }

  const chooseApplication = async (): Promise<void> => {
    setPicking(true)
    try {
      const picked = await window.api.shell.pickOpenInAppIcon()
      if (!mountedRef.current) {
        return
      }
      if (picked) {
        select({ type: 'image', src: picked.dataUrl })
      }
    } catch (error) {
      // Why: the icon lives inside a signed app bundle on macOS and a packed
      // resource on Windows — extraction can fail on a file that still opens fine.
      toast.error(
        translate(
          'auto.components.settings.OpenInAppIconPicker.chooseApplicationFailed',
          'Could not read that application icon.'
        ),
        { description: error instanceof Error ? error.message : undefined }
      )
    } finally {
      setPicking(false)
    }
  }

  const changeIconLabel = translate(
    'auto.components.settings.OpenInAppIconPicker.changeIcon',
    'Change app icon'
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={hasAppIcon ? 'ghost' : 'outline'}
          size="icon-sm"
          className={cn(
            'size-7 shrink-0 overflow-hidden',
            hasAppIcon && 'p-0 hover:bg-transparent hover:opacity-80'
          )}
          title={changeIconLabel}
          aria-label={changeIconLabel}
        >
          {/* `size` governs only the glyph fallback, which Button pins to size-4 anyway. */}
          <OpenInApplicationIcon
            application={application}
            size={16}
            imageClassName="size-full rounded-md"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto space-y-2 p-2">
        <OpenInAppIconGrid
          selectedId={selectedId}
          onSelect={(id) => select({ type: 'bundled', id })}
        />
        <div className="space-y-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-full justify-start"
            disabled={picking}
            onClick={() => void chooseApplication()}
          >
            <AppWindowMac />
            {translate(
              'auto.components.settings.OpenInAppIconPicker.chooseApplication',
              "Use an installed app's icon…"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-full justify-start text-muted-foreground"
            disabled={!application.icon}
            onClick={() => select(null)}
          >
            <RotateCcw />
            {translate(
              'auto.components.settings.OpenInAppIconPicker.useDefaultIcon',
              'Use default icon'
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

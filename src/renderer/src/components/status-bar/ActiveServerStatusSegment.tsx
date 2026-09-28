import { useRef, useState } from 'react'
import { ChevronDown, Loader2, Server } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { useAppStore } from '@/store'
import { isUserManagedRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { LOCAL_RUNTIME_VALUE } from '../settings/runtime-environment-selection'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

export function ActiveServerStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const setActiveRuntimeEnvironmentPreference = useAppStore(
    (state) => state.setActiveRuntimeEnvironmentPreference
  )
  const [switching, setSwitching] = useState(false)
  const switchingRef = useRef(false)
  const mountedRef = useMountedRef()
  const environments = runtimeEnvironments.filter(isUserManagedRuntimeEnvironment)
  const activeId = settings?.activeRuntimeEnvironmentId ?? null
  const activeValue = activeId ?? LOCAL_RUNTIME_VALUE
  const localLabel = translate(
    'auto.components.settings.RuntimeEnvironmentsPane.78692becbd',
    'Local desktop'
  )
  const title = translate(
    'auto.components.settings.RuntimeEnvironmentsPane.64b6bea541',
    'Active Server'
  )
  const activeLabel = activeId
    ? (environments.find((environment) => environment.id === activeId)?.name ?? activeId)
    : localLabel
  const label = `${title}: ${activeLabel}`

  const switchServer = async (value: string): Promise<void> => {
    if (switchingRef.current || value === activeValue) {
      return
    }
    switchingRef.current = true
    setSwitching(true)
    try {
      await setActiveRuntimeEnvironmentPreference(value === LOCAL_RUNTIME_VALUE ? null : value)
    } finally {
      switchingRef.current = false
      if (mountedRef.current) {
        setSwitching(false)
      }
    }
  }

  if (!settings || environments.length === 0 || isPairedWebClientWindow()) {
    return null
  }

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/70 hover:text-foreground disabled:opacity-50"
              aria-label={label}
              aria-busy={switching}
              disabled={switching}
            >
              {switching ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Server className="size-3" />
              )}
              {!iconOnly ? (
                <span className="max-w-32 truncate text-[11px]">{activeLabel}</span>
              ) : null}
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {iconOnly ? (
          <TooltipContent side="top" sideOffset={6}>
            {label}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="start"
        sideOffset={8}
      >
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={activeValue}
          onValueChange={(value) => void switchServer(value)}
        >
          <DropdownMenuRadioItem value={LOCAL_RUNTIME_VALUE} disabled={switching}>
            {localLabel}
          </DropdownMenuRadioItem>
          {environments.map((environment) => (
            <DropdownMenuRadioItem key={environment.id} value={environment.id} disabled={switching}>
              {environment.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import { useEffect, useState } from 'react'
import { Coffee } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { translate } from '@/i18n/i18n'
import {
  getAgentAwakeLidNote,
  getAgentAwakeModeLabel,
  getAgentAwakeTitle
} from '../settings/agent-awake-copy'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode,
  type ComputerAwakeStatus
} from '../../../../shared/computer-awake-mode'
import { useSystemSleepHold } from '@/hooks/system-sleep-hold-status'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import {
  appendHoldSentence,
  endHoldSentence,
  getOrcaOwnStatus,
  getSleepHoldLabel,
  getSleepHoldLidClosed,
  getSleepHoldSentence,
  getSleepHoldUnchecked,
  isSleepHeld,
  joinHoldSentences
} from './system-sleep-hold-copy'

const INACTIVE_STATUS: ComputerAwakeStatus = {
  mode: 'off',
  active: false
}

function activityLabel(active: boolean): string {
  return active
    ? translate('auto.components.status.bar.CaffeinateStatusSegment.active', 'Active')
    : translate('auto.components.status.bar.CaffeinateStatusSegment.inactive', 'Inactive')
}

export function CaffeinateStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const configuredMode = normalizeComputerAwakeMode(
    settings?.computerAwakeMode,
    settings?.keepComputerAwakeWhileAgentsRun
  )
  const [serviceStatus, setServiceStatus] = useState<ComputerAwakeStatus>(INACTIVE_STATUS)
  const { state: holdState, refresh: refreshSleepHold } = useSystemSleepHold()

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.api.agentAwake.onChanged((status) => {
      if (mounted) {
        setServiceStatus(status)
      }
    })
    void window.api.agentAwake
      .getStatus()
      .then((status) => {
        if (mounted) {
          setServiceStatus(status)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  if (isPairedWebClientWindow()) {
    return null
  }

  const mode = serviceStatus.mode === configuredMode ? serviceStatus.mode : configuredMode
  const orcaActive =
    serviceStatus.mode === configuredMode ? serviceStatus.active : configuredMode === 'on'
  const held = isSleepHeld(holdState)
  const active = held || orcaActive
  const title = getAgentAwakeTitle()
  const statusText = `${getAgentAwakeModeLabel(mode)} · ${activityLabel(orcaActive)}`
  const unchecked = holdState === 'unchecked'
  const holdSentence = held ? getSleepHoldSentence() : unchecked ? getSleepHoldUnchecked() : ''
  // Why: the same template twice keeps each locale's own separator between the three parts.
  const heldStatusText = holdSentence
    ? translate(
        'auto.components.status.bar.CaffeinateStatusSegment.ariaLabel',
        '{{title}}, {{status}}',
        {
          title: holdSentence,
          status: statusText
        }
      )
    : statusText
  const ariaLabel = translate(
    'auto.components.status.bar.CaffeinateStatusSegment.ariaLabel',
    '{{title}}, {{status}}',
    { title, status: heldStatusText }
  )
  const barLabel = held ? getSleepHoldLabel() : getAgentAwakeModeLabel(mode)
  const menuHoldNote = held
    ? joinHoldSentences(holdSentence, getSleepHoldLidClosed())
    : unchecked
      ? holdSentence
      : null
  const todayAriaLabel = translate(
    'auto.components.status.bar.CaffeinateStatusSegment.ariaLabel',
    '{{title}}, {{status}}',
    { title, status: statusText }
  )
  const tooltipText = held
    ? appendHoldSentence(
        joinHoldSentences(holdSentence, getSleepHoldLidClosed()),
        getOrcaOwnStatus(statusText)
      )
    : unchecked
      ? joinHoldSentences(todayAriaLabel, endHoldSentence(holdSentence))
      : `${todayAriaLabel}. ${getAgentAwakeLidNote()}`

  const setMode = (nextMode: string): void => {
    void updateSettings(computerAwakeSettingsForMode(normalizeComputerAwakeMode(nextMode)))
  }

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) {
          refreshSleepHold()
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              aria-label={ariaLabel}
            >
              <Coffee className={`size-3 ${active ? 'text-foreground' : ''}`} />
              {!iconOnly ? <span className="text-[11px] font-medium">{barLabel}</span> : null}
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${
                  active ? 'bg-foreground' : 'bg-muted-foreground/40'
                }`}
              />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {tooltipText}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="end"
        sideOffset={8}
        className="w-64"
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-3">
          <span>{title}</span>
          <span className="font-normal text-muted-foreground">{statusText}</span>
        </DropdownMenuLabel>
        {menuHoldNote ? (
          <div className="px-2 pb-1.5 text-[11px] text-muted-foreground">{menuHoldNote}</div>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={mode} onValueChange={setMode}>
          <DropdownMenuRadioItem value="on" className="py-1.5">
            <span className="flex flex-col">
              <span>{getAgentAwakeModeLabel('on')}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {translate(
                  'auto.components.status.bar.CaffeinateStatusSegment.onDescription',
                  'Keep this computer awake continuously'
                )}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="auto" className="py-1.5">
            <span className="flex flex-col">
              <span>{getAgentAwakeModeLabel('auto')}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {translate(
                  'auto.components.status.bar.CaffeinateStatusSegment.autoDescription',
                  'Stay awake while an agent is working'
                )}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off" className="py-1.5">
            <span className="flex flex-col">
              <span>{getAgentAwakeModeLabel('off')}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {translate(
                  'auto.components.status.bar.CaffeinateStatusSegment.offDescription',
                  'Allow normal system sleep behavior'
                )}
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

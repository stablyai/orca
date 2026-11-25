import React from 'react'
import { LoaderCircle, MoreHorizontal, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { useTranslate } from '@/i18n/use-translate'

/** A control that is off for a reason keeps its focus and says why through the notice it names. */
export type AutomationControlState = {
  /** In flight: aria-busy, and presses are ignored. */
  pending?: boolean
  /** Unavailable: aria-disabled, described by `describedBy`. */
  unavailable?: boolean
  /** The notice that says why it's unavailable. */
  describedBy?: string
}

/** Ignores presses while pending or unavailable, without `disabled`, so focus stays put. */
export function softDisabledProps(
  state: AutomationControlState | undefined,
  onPress: () => void
): {
  'aria-disabled'?: true
  'aria-busy'?: true
  'aria-describedby'?: string
  onClick: (event: React.MouseEvent) => void
} {
  const off = Boolean(state?.pending || state?.unavailable)
  return {
    ...(off ? { 'aria-disabled': true as const } : {}),
    ...(state?.pending ? { 'aria-busy': true as const } : {}),
    ...(state?.unavailable && state.describedBy ? { 'aria-describedby': state.describedBy } : {}),
    onClick: (event) => {
      if (off) {
        event.preventDefault()
        return
      }
      onPress()
    }
  }
}

type HeaderProps = {
  automation: Automation
  subtitle: string
  onRunNow: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete?: (automation: Automation) => void
  runNowState?: AutomationControlState
  /** Run now's label while pending ("Starting…"). */
  runNowPendingLabel?: string
  runNowLabel?: string
  toggleState?: AutomationControlState
  deleteState?: AutomationControlState
  /** Menu items before Delete; the page's are Pause/Resume. */
  menuItems?: React.ReactNode
  /** The heading's id, for a region it names. */
  titleId?: string
}

function ActionsMenu({
  automation,
  menuItems,
  onDelete,
  deleteState
}: Pick<HeaderProps, 'automation' | 'menuItems' | 'onDelete' | 'deleteState'>): React.JSX.Element {
  const t = useTranslate()
  const label = t(
    'auto.components.automations.AutomationDetail.moreActions',
    'More actions for {{name}}',
    { name: automation.name }
  )
  const deleteOff = Boolean(deleteState?.pending || deleteState?.unavailable)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={label}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-48">
        {menuItems}
        {onDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              aria-disabled={deleteOff || undefined}
              aria-describedby={deleteState?.unavailable ? deleteState.describedBy : undefined}
              onSelect={(event) => {
                if (deleteOff) {
                  event.preventDefault()
                  return
                }
                onDelete(automation)
              }}
            >
              <Trash2 className="size-3.5" />
              {t('auto.components.automations.AutomationDetail.deleteEllipsis', 'Delete…')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AutomationDetailHeader(props: HeaderProps): React.JSX.Element {
  const t = useTranslate()
  const {
    automation,
    subtitle,
    onRunNow,
    onToggle,
    runNowState,
    runNowPendingLabel,
    toggleState,
    titleId
  } = props
  const runNowLabel =
    props.runNowLabel ??
    (runNowState?.pending
      ? (runNowPendingLabel ??
        t('auto.components.automations.AutomationDetail.starting', 'Starting…'))
      : t('components.native-chat.automationSaved.runNow', 'Run now'))

  const toggleOff = Boolean(toggleState?.pending || toggleState?.unavailable)
  return (
    <header className="flex min-w-0 flex-col gap-2.5">
      <div className="min-w-0">
        <h2
          id={titleId}
          className="text-base font-semibold leading-snug tracking-tight [overflow-wrap:anywhere]"
        >
          {automation.name}
        </h2>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <Switch
            checked={automation.enabled}
            aria-label={automation.name}
            aria-disabled={toggleOff || undefined}
            aria-busy={toggleState?.pending || undefined}
            aria-describedby={toggleState?.unavailable ? toggleState.describedBy : undefined}
            onCheckedChange={() => {
              if (!toggleOff) {
                onToggle(automation)
              }
            }}
          />
          <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {subtitle}
          </span>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        {/* Native disabled would drop focus; aria-disabled keeps it, so the wrapper dims it. */}
        <span
          className={cn(
            'flex min-w-0 flex-1',
            (runNowState?.pending || runNowState?.unavailable) && 'opacity-50'
          )}
        >
          <Button
            type="button"
            size="sm"
            className="w-full min-w-0"
            {...softDisabledProps(runNowState, () => onRunNow(automation))}
          >
            {runNowState?.pending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            <span className="truncate">{runNowLabel}</span>
          </Button>
        </span>
        <ActionsMenu {...props} />
      </div>
    </header>
  )
}

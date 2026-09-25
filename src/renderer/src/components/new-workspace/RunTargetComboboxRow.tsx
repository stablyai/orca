import React from 'react'
import { AlertTriangle, ChevronRight, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { ProjectOptionDetail } from './ProjectComboboxRow'
import { translate } from '@/i18n/i18n'
import { HostRowIcon } from '../host-row-icon'

export { HostRowIcon }

/**
 * One run-target row. Shares the Project picker's shape — 32px, label and
 * right-aligned detail on one baseline — so the two composer fields read as one
 * control. `stacked` switches to a two-line card for the Add-host choices,
 * where the description explains what you're picking rather than labelling a
 * thing you already know.
 */
export function RunTargetRow({
  icon,
  label,
  detail,
  armed,
  current,
  optionId,
  dimmed = false,
  submenu = false,
  stacked = false,
  onArm,
  onCommit,
  trailing
}: {
  icon: React.ReactNode
  label: string
  detail: string
  armed: boolean
  current: boolean
  optionId: string | undefined
  /** Not-ready hosts are dormant, not errors — quiet them without disabling. */
  dimmed?: boolean
  /** Opens a nested list, so it gets a trailing chevron. */
  submenu?: boolean
  /** Two-line card: label over description, for rows that need explaining. */
  stacked?: boolean
  onArm: () => void
  onCommit: () => void
  trailing?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="option"
      id={optionId}
      aria-selected={armed}
      // `option` supports aria-haspopup but not aria-expanded, so the row
      // announces that it opens a menu without claiming an invalid state.
      aria-haspopup={submenu ? 'menu' : undefined}
      data-armed={armed || undefined}
      data-current={current ? 'true' : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onArm}
      onClick={onCommit}
      className={cn(
        'flex cursor-default gap-2 rounded-sm px-2 text-sm',
        stacked ? 'items-center py-1.5' : 'h-8 items-baseline',
        armed && 'bg-accent text-accent-foreground',
        current && !armed && 'bg-accent/60'
      )}
    >
      {/* Icons are glyphs, not text, so they centre on the row. */}
      <span
        className={cn(
          'flex shrink-0 items-center',
          stacked ? 'self-start pt-0.5' : 'h-8',
          dimmed && 'opacity-60'
        )}
      >
        {icon}
      </span>
      {stacked ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn('truncate', current && 'font-medium')}>{label}</span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </span>
      ) : (
        <>
          <span
            className={cn(
              'max-w-[50%] shrink truncate',
              current && 'font-medium',
              dimmed && 'opacity-60'
            )}
          >
            {label}
          </span>
          <ProjectOptionDetail
            detail={detail}
            className={cn(
              'ml-auto min-w-0 flex-1 shrink-[999] justify-end pl-2 text-right text-xs text-muted-foreground',
              dimmed && 'opacity-60'
            )}
          />
        </>
      )}
      {trailing}
      {submenu ? (
        <span className={cn('flex shrink-0 items-center pl-1.5', stacked ? 'self-center' : 'h-8')}>
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </span>
      ) : null}
    </div>
  )
}

/** Glyph for a host that can't run yet: connecting, broken, or merely dormant. */
export function NeedsSetupHostIcon({
  hostId,
  connecting,
  attention
}: {
  hostId: ExecutionHostId
  connecting: boolean
  attention: boolean
}): React.JSX.Element {
  if (connecting) {
    return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  }
  if (attention) {
    return <AlertTriangle className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <HostRowIcon hostId={hostId} />
}

/** Inline Connect action on a disconnected host row. */
export function ConnectHostButton({
  connecting,
  onConnect
}: {
  connecting: boolean
  onConnect: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      // Why: only the row being connected is disabled, so one slow connect
      // can't lock out connecting to the others.
      disabled={connecting}
      className="ml-1 shrink-0 gap-1 self-center text-muted-foreground/70 hover:text-foreground"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        // Why: keep the picker open so the connecting state stays visible; the
        // row updates in place once store SSH state resolves.
        onConnect()
      }}
    >
      {connecting ? (
        <>
          <LoaderCircle className="size-3 animate-spin" />
          {translate('auto.components.NewWorkspaceComposerCard.connectingHost', 'Connecting…')}
        </>
      ) : (
        translate('auto.components.NewWorkspaceComposerCard.connectHost', 'Connect')
      )}
    </Button>
  )
}

/** Inline Set project location action on a host that still needs a project path. */
export function SetLocationButton({
  hostLabel,
  onSetLocation
}: {
  hostLabel: string
  onSetLocation: () => void
}): React.JSX.Element {
  const label = translate(
    'auto.components.NewWorkspaceComposerCard.setLocation',
    'Set project location'
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ml-auto shrink-0 self-center"
          aria-label={translate(
            'auto.components.NewWorkspaceComposerCard.setLocationOnHost',
            'Set project location on {{host}}',
            { host: hostLabel }
          )}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onSetLocation()
          }}
        >
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {translate(
          'auto.components.NewWorkspaceComposerCard.setLocationTooltip',
          'Choose a folder or clone this project onto {{host}}.',
          { host: hostLabel }
        )}
      </TooltipContent>
    </Tooltip>
  )
}

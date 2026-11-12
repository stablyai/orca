import React from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useTranslate } from '@/i18n/use-translate'
import { HostRowIcon } from '../host-row-icon'

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

export function ConnectHostButton({
  connecting,
  onConnect
}: {
  connecting: boolean
  onConnect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // A row inside role="option" can't hold a focusable button (axe nested-interactive, DS-22): a
  // button-styled span keeps the pointer action; the option itself is what the keyboard reaches.
  return (
    <span
      aria-disabled={connecting || undefined}
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'xs' }),
        'ml-1 shrink-0 gap-1 self-center text-muted-foreground/70 hover:text-foreground',
        connecting && 'pointer-events-none opacity-50'
      )}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (connecting) {
          return
        }
        // Keep the picker open so connection progress and resolved host state remain visible.
        onConnect()
      }}
    >
      {connecting ? (
        <>
          <LoaderCircle className="size-3 animate-spin" />
          {t('auto.components.NewWorkspaceComposerCard.connectingHost', 'Connecting…')}
        </>
      ) : (
        t('auto.components.NewWorkspaceComposerCard.connectHost', 'Connect')
      )}
    </span>
  )
}

export function SetLocationButton({
  hostLabel,
  onSetLocation
}: {
  hostLabel: string
  onSetLocation: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.NewWorkspaceComposerCard.setLocation', 'Set project location')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'xs' }),
            'ml-auto shrink-0 self-center'
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
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {t(
          'auto.components.NewWorkspaceComposerCard.setLocationTooltip',
          'Choose a folder or clone this project onto {{host}}.',
          { host: hostLabel }
        )}
      </TooltipContent>
    </Tooltip>
  )
}

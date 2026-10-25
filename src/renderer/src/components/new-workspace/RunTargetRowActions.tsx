import React from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
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

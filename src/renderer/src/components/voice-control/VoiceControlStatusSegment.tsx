import { Mic, MicOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { VoiceControlState } from '../../../../shared/voice-control-types'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '../status-bar/status-bar-context-menu-policy'
import { dispatchVoiceControlAction } from './voice-control-events'
import { useVoiceControlState } from './voice-control-store'

// Why: the floating pill can be missed; this segment is the always-visible honest
// open-mic affordance while any control session is non-idle.

type SegmentPresentation = {
  label: string
  ariaLabel: string
  destructive: boolean
}

function presentationFor(state: Exclude<VoiceControlState, 'idle'>): SegmentPresentation {
  switch (state) {
    case 'live':
      return {
        label: translate(
          'auto.components.voice.control.VoiceControlStatusSegment.12a1f27aee',
          'Live'
        ),
        ariaLabel: translate(
          'auto.components.voice.control.VoiceControlStatusSegment.bcd842b147',
          'Voice control is live with the mic open. Click to stop.'
        ),
        destructive: false
      }
    case 'minting':
    case 'awaiting-sdp':
      return {
        label: translate(
          'auto.components.voice.control.VoiceControlStatusSegment.68207f4bf7',
          'Connecting…'
        ),
        ariaLabel: translate(
          'auto.components.voice.control.VoiceControlStatusSegment.bfaf7efee4',
          'Voice control is connecting. Click to stop.'
        ),
        destructive: false
      }
    case 'stopping':
      return {
        label: translate(
          'auto.components.voice.control.VoiceControlStatusSegment.ad8a798db4',
          'Stopping…'
        ),
        ariaLabel: translate(
          'auto.components.voice.control.VoiceControlStatusSegment.5672a03f58',
          'Voice control is stopping.'
        ),
        destructive: false
      }
    case 'error':
      return {
        label: translate(
          'auto.components.voice.control.VoiceControlStatusSegment.b5f29ae8d9',
          'Error'
        ),
        ariaLabel: translate(
          'auto.components.voice.control.VoiceControlStatusSegment.aa984ca8c7',
          'Voice control error. Click to stop and reset.'
        ),
        destructive: true
      }
  }
}

export function VoiceControlStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const state = useVoiceControlState()
  if (state === 'idle') {
    return null
  }
  const { label, ariaLabel, destructive } = presentationFor(state)
  const Icon = state === 'error' ? MicOff : Mic
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="voice-control-status-segment"
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-accent/70',
            destructive
              ? 'text-destructive hover:text-destructive'
              : 'text-muted-foreground hover:text-foreground'
          )}
          aria-label={ariaLabel}
          // Why: keep focus on the pane the user was in — the session stops either way.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => dispatchVoiceControlAction('stop')}
        >
          <Icon className={cn('size-3', state === 'live' && !destructive && 'text-foreground')} />
          {!iconOnly ? <span className="text-[11px] font-medium">{label}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {ariaLabel}
      </TooltipContent>
    </Tooltip>
  )
}

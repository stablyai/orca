import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  useVoiceControlAgents,
  useVoiceControlOutputLevel,
  useVoiceControlState,
  useVoiceControlTranscriptPanelOpen,
  type VoiceControlAgentChip
} from './voice-control-store'

type AgentSpeakingChipProps = {
  paneKey: string
  // Why: the store's map never holds 'idle' (idle deletes the entry), but its value
  // type is the full event union; a stray 'idle' simply renders as working.
  chip: VoiceControlAgentChip
  outputLevel: number
}

function AgentSpeakingChip({ paneKey, chip, outputLevel }: AgentSpeakingChipProps) {
  const entry = useAppStore((state) => state.agentStatusByPaneKey[paneKey])
  const agentType = entry?.agentType
  // The user knows agents by their roster names ("oak"), not their provider type —
  // two Claude panes both labeled "Claude" told you nothing. Pane-less updates (watchdog
  // findings, session notes) carry their own spokenName and skip the roster lookup.
  const name =
    chip.spokenName ??
    (agentType && agentType !== 'unknown' ? formatAgentTypeLabel(agentType) : null) ??
    translate('auto.components.voice.control.AgentSpeakingChips.2f19979ffd', 'Unknown agent')
  const speaking = chip.activity === 'speaking'
  const stateLabel = speaking
    ? translate('auto.components.voice.control.AgentSpeakingChips.d769377dd7', 'Speaking')
    : translate('auto.components.voice.control.AgentSpeakingChips.eb42999570', 'Working…')

  return (
    <span
      data-testid="agent-speaking-chip"
      data-agent-pane={paneKey}
      data-activity={chip.activity}
      className={cn(
        'flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs shadow-floating backdrop-blur',
        speaking
          ? 'bg-accent text-accent-foreground transition-transform duration-100 ease-out motion-reduce:transition-none'
          : 'bg-popover/95 text-muted-foreground animate-pulse motion-reduce:animate-none'
      )}
      style={speaking ? { transform: `scale(${1 + outputLevel * 0.05})` } : undefined}
    >
      <AgentIcon agent={agentTypeToIconAgent(agentType)} size={12} />
      <span className="max-w-32 truncate font-medium">{name}</span>
      <span className="sr-only">{stateLabel}</span>
    </span>
  )
}

/** Per-agent chips floating directly above the control pill while the session is live. */
export function AgentSpeakingChips() {
  const state = useVoiceControlState()
  const agents = useVoiceControlAgents()
  const outputLevel = useVoiceControlOutputLevel()
  const panelOpen = useVoiceControlTranscriptPanelOpen()

  const entries = Object.entries(agents)
  // The transcript panel takes this slot when open; its update rows carry the same info.
  if (state !== 'live' || entries.length === 0 || panelOpen) {
    return null
  }

  return (
    <div
      data-testid="agent-speaking-chips"
      className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5"
    >
      {entries.map(([paneKey, chip]) => (
        <AgentSpeakingChip key={paneKey} paneKey={paneKey} chip={chip} outputLevel={outputLevel} />
      ))}
    </div>
  )
}

import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type {
  VoiceControlAgentActivityEvent,
  VoiceControlErrorKind,
  VoiceControlState,
  VoiceControlStateChangedEvent,
  VoiceControlToolActivityEvent,
  VoiceTranscriptEntry
} from '../../../../shared/voice-control-types'
import { toolActivityLabel } from './voice-control-tool-activity-label'
import type { VoiceControlTranscriptLine } from './voice-control-transcript-events'

/** A chip's rendered state: what the agent is doing plus the name the user knows it by. */
export type VoiceControlAgentChip = {
  activity: VoiceControlAgentActivityEvent['activity']
  spokenName?: string
}

export type VoiceControlUiState = {
  state: VoiceControlState
  sessionId: string | null
  errorKind: VoiceControlErrorKind | null
  error: string | null
  /** Latest tool-dispatch narration, shown in the pill while live. */
  toolActivity: string | null
  /** Local mic level 0..1 for the live meter. */
  micLevel: number
  /** Remote (coordinator voice) level 0..1 for the output waveform. */
  outputLevel: number
  /** Per-agent chip state by paneKey, fed by main's agent-activity events. */
  agents: Record<string, VoiceControlAgentChip>
  /** Rolling completed transcript lines, oldest first, for toasts. */
  transcript: VoiceControlTranscriptLine[]
  /** The full session feed for the transcript panel: user, assistant, commands, updates. */
  transcriptEntries: VoiceTranscriptEntry[]
  /** Whether the pill-anchored transcript panel is expanded. */
  transcriptPanelOpen: boolean
}

/** The transcript is a convenience log, not history — keep it small. */
const TRANSCRIPT_LIMIT = 20
/** The panel's feed matches main's readback bound so live and backfill never diverge. */
const TRANSCRIPT_ENTRIES_LIMIT = 200

const IDLE: VoiceControlUiState = {
  state: 'idle',
  sessionId: null,
  errorKind: null,
  error: null,
  toolActivity: null,
  micLevel: 0,
  outputLevel: 0,
  agents: {},
  transcript: [],
  transcriptEntries: [],
  transcriptPanelOpen: false
}

const voiceControlStore = createStore<VoiceControlUiState>()(() => IDLE)

export function publishVoiceControlState(event: VoiceControlStateChangedEvent): void {
  const ending = event.state === 'idle' || event.state === 'error'
  voiceControlStore.setState({
    state: event.state,
    sessionId: event.sessionId,
    errorKind: event.errorKind ?? null,
    error: event.error ?? null,
    // Clear live-only fields when a session ends so nothing stale lingers.
    toolActivity: ending ? null : voiceControlStore.getState().toolActivity,
    agents: ending ? {} : voiceControlStore.getState().agents,
    ...(event.state === 'idle' ? { transcript: [] } : {})
  })
}

export function publishVoiceControlToolActivity(event: VoiceControlToolActivityEvent): void {
  const label = toolActivityLabel(event.tool, event.target)
  if (label === null) {
    return
  }
  voiceControlStore.setState({ toolActivity: label })
}

export function publishVoiceControlAgentActivity(event: VoiceControlAgentActivityEvent): void {
  const agents = { ...voiceControlStore.getState().agents }
  if (event.activity === 'idle') {
    delete agents[event.paneKey]
  } else {
    agents[event.paneKey] = { activity: event.activity, spokenName: event.spokenName }
  }
  voiceControlStore.setState({
    agents,
    // A reply being spoken supersedes "waiting for a reply" narration.
    ...(event.activity === 'speaking' ? { toolActivity: null } : {})
  })
}

export function publishVoiceControlTranscript(line: VoiceControlTranscriptLine): void {
  const transcript = [...voiceControlStore.getState().transcript, line]
  voiceControlStore.setState({
    transcript: transcript.slice(-TRANSCRIPT_LIMIT),
    // The user speaking again supersedes any stale tool narration.
    ...(line.speaker === 'user' ? { toolActivity: null } : {})
  })
}

/** One live transcript entry from main (the same feed the durable log records). */
export function publishVoiceControlTranscriptEntry(entry: VoiceTranscriptEntry): void {
  const entries = [...voiceControlStore.getState().transcriptEntries, entry]
  voiceControlStore.setState({ transcriptEntries: entries.slice(-TRANSCRIPT_ENTRIES_LIMIT) })
}

/** Panel open backfill: the log's readback, keeping live entries that landed mid-fetch. */
export function hydrateVoiceControlTranscript(entries: VoiceTranscriptEntry[]): void {
  const live = voiceControlStore.getState().transcriptEntries
  const maxTs = entries.reduce((max, entry) => Math.max(max, entry.ts), Number.NEGATIVE_INFINITY)
  const merged = [...entries, ...live.filter((entry) => entry.ts > maxTs)]
  voiceControlStore.setState({ transcriptEntries: merged.slice(-TRANSCRIPT_ENTRIES_LIMIT) })
}

export function setVoiceControlTranscriptPanelOpen(open: boolean): void {
  voiceControlStore.setState({ transcriptPanelOpen: open })
}

export function publishVoiceControlMicLevel(level: number): void {
  if (Math.abs(voiceControlStore.getState().micLevel - level) > 0.02) {
    voiceControlStore.setState({ micLevel: level })
  }
}

export function publishVoiceControlOutputLevel(level: number): void {
  if (Math.abs(voiceControlStore.getState().outputLevel - level) > 0.02) {
    voiceControlStore.setState({ outputLevel: level })
  }
}

export function resetVoiceControl(): void {
  voiceControlStore.setState(IDLE, true)
}

/** Imperative read for event callbacks — subscribing a lifecycle component to the whole store re-renders it on every mic-level tick. */
export function getVoiceControlUiState(): VoiceControlUiState {
  return voiceControlStore.getState()
}

export function useVoiceControlUi(): VoiceControlUiState {
  return useStore(voiceControlStore, (state) => state)
}

export function useVoiceControlState(): VoiceControlState {
  return useStore(voiceControlStore, (state) => state.state)
}

export function useVoiceControlSessionId(): string | null {
  return useStore(voiceControlStore, (state) => state.sessionId)
}

export function useVoiceControlErrorKind(): VoiceControlErrorKind | null {
  return useStore(voiceControlStore, (state) => state.errorKind)
}

export function useVoiceControlToolActivity(): string | null {
  return useStore(voiceControlStore, (state) => state.toolActivity)
}

export function useVoiceControlMicLevel(): number {
  return useStore(voiceControlStore, (state) => state.micLevel)
}

export function useVoiceControlAgents(): VoiceControlUiState['agents'] {
  return useStore(voiceControlStore, (state) => state.agents)
}

export function useVoiceControlOutputLevel(): number {
  return useStore(voiceControlStore, (state) => state.outputLevel)
}

export function useVoiceControlTranscript(): VoiceControlTranscriptLine[] {
  return useStore(voiceControlStore, (state) => state.transcript)
}

export function useVoiceControlTranscriptEntries(): VoiceTranscriptEntry[] {
  return useStore(voiceControlStore, (state) => state.transcriptEntries)
}

export function useVoiceControlTranscriptPanelOpen(): boolean {
  return useStore(voiceControlStore, (state) => state.transcriptPanelOpen)
}

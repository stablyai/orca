import { create } from 'zustand'
import type { ExecutionHostId } from '../../../shared/execution-host'

type VoiceSession = { sessionId: string; tabId: string; executionHostId: ExecutionHostId }
export type VoiceSessionEntry =
  | { status: 'opening' }
  | { status: 'ready'; session: VoiceSession }
  | { status: 'failed' }

export const useVoiceSidebarSessions = create<{
  entries: Record<string, VoiceSessionEntry>
  portal: { tabId: string; container: HTMLElement } | null
}>(() => ({ entries: {}, portal: null }))

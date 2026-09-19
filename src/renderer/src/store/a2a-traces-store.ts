import { create } from 'zustand'
import {
  parseTerminalIndex,
  type A2ALinkEvent,
  type A2ALinkType
} from '../../../shared/terminal-a2a-link'

export type A2ATracesState = {
  activeLinks: A2ALinkEvent[]
  recentTraces: A2ALinkEvent[]
  isHubOpen: boolean
  hubTab: 'topology' | 'stream'
  selectedAgentIndex: number | null
  setHubOpen: (open: boolean) => void
  toggleHub: () => void
  setHubTab: (tab: 'topology' | 'stream') => void
  setSelectedAgentIndex: (idx: number | null) => void
  addTrace: (
    trace: {
      id?: string
      from: string
      to: string
      fromIndex?: number
      toIndex?: number
      fromLabel?: string
      toLabel?: string
      type?: A2ALinkType
      text?: string
      timestamp?: number
      durationMs?: number
    }
  ) => A2ALinkEvent
  removeActiveLink: (id: string) => void
  replayTrace: (id: string) => void
  clearTraces: () => void
}

const DEFAULT_DURATION_MS = 4500
const MAX_RECENT_TRACES = 100

export const useA2AStore = create<A2ATracesState>((set, get) => ({
  activeLinks: [],
  recentTraces: [],
  isHubOpen: false,
  hubTab: 'topology',
  selectedAgentIndex: null,

  setHubOpen: (isHubOpen) => set({ isHubOpen }),
  toggleHub: () => set((state) => ({ isHubOpen: !state.isHubOpen })),
  setHubTab: (hubTab) => set({ hubTab }),
  setSelectedAgentIndex: (selectedAgentIndex) => set({ selectedAgentIndex }),

  addTrace: (input) => {
    const timestamp = input.timestamp ?? Date.now()
    const id = input.id ?? `a2a-${timestamp}-${Math.random().toString(36).slice(2, 7)}`
    const fromIndex = input.fromIndex ?? parseTerminalIndex(input.from)
    const toIndex = input.toIndex ?? parseTerminalIndex(input.to)
    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS

    const event: A2ALinkEvent = {
      id,
      from: input.from,
      to: input.to,
      fromIndex,
      toIndex,
      fromLabel: input.fromLabel,
      toLabel: input.toLabel,
      type: input.type ?? 'send',
      text: input.text,
      timestamp,
      durationMs
    }

    set((state) => {
      // Filter out any duplicate id
      const nextActive = [...state.activeLinks.filter((l) => l.id !== id), event]
      const nextRecent = [event, ...state.recentTraces.filter((l) => l.id !== id)].slice(
        0,
        MAX_RECENT_TRACES
      )
      return { activeLinks: nextActive, recentTraces: nextRecent }
    })

    // Auto-remove from activeLinks when duration expires
    setTimeout(() => {
      get().removeActiveLink(id)
    }, durationMs)

    return event
  },

  removeActiveLink: (id: string) => {
    set((state) => ({
      activeLinks: state.activeLinks.filter((l) => l.id !== id)
    }))
  },

  replayTrace: (id: string) => {
    const state = get()
    const found = state.recentTraces.find((t) => t.id === id)
    if (found) {
      get().addTrace({
        ...found,
        id: undefined,
        timestamp: Date.now()
      })
    }
  },

  clearTraces: () => {
    set({ activeLinks: [], recentTraces: [] })
  }
}))

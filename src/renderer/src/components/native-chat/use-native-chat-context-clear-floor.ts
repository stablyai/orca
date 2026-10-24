import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import {
  agentSessionTranscriptRows,
  latestAgentSessionContextClearSequence
} from '../../../../shared/agent-session-context-clear'

/** Matches the transcript's `duration-150` fade, so the swap happens while it is invisible. */
export const NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS = 150

type ClearFloorState = {
  epoch: string | null
  /** The sequence the transcript starts from: its latest `/clear` divider, 0 for none. */
  floor: number
  /** A clear that landed live, waiting for the old transcript to fade out. */
  fading: number | null
  /** Bumped per live clear; keys the list so nothing the cleared transcript held carries over. */
  clears: number
}

/**
 * The rows a structured chat's transcript shows: from its latest `/clear` divider on. A clear
 * landing live fades the old transcript out before it goes; a divider paged in from history just
 * becomes the top, keeping the scroll.
 */
export function useNativeChatContextClearFloor(
  epoch: string | null,
  items: readonly AgentJournalRenderItem[]
): { rows: readonly AgentJournalRenderItem[]; clearing: boolean; clears: number } {
  const latest = useMemo(() => latestAgentSessionContextClearSequence(items), [items])
  const [state, setState] = useState<ClearFloorState>(() => ({
    epoch,
    floor: latest,
    fading: null,
    clears: 0
  }))
  // The newest row the last commit drew: a divider past it arrived live, not from an older page.
  const tail = items.at(-1)?.sequence ?? 0
  const drawnTail = useRef(tail)
  useEffect(() => {
    drawnTail.current = tail
  }, [tail])

  let current = state
  if (epoch !== state.epoch) {
    // A new journal (first read or a rewind) remounts the list on its own; nothing to fade.
    current = { ...state, epoch, floor: latest, fading: null }
    setState(current)
  } else if (latest > (state.fading ?? state.floor)) {
    current =
      latest > drawnTail.current ? { ...state, fading: latest } : { ...state, floor: latest }
    setState(current)
  }

  const fading = current.fading
  useEffect(() => {
    if (fading === null) {
      return
    }
    const timer = setTimeout(
      () =>
        setState((prior) =>
          prior.fading === fading
            ? { ...prior, floor: fading, fading: null, clears: prior.clears + 1 }
            : prior
        ),
      NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS
    )
    return () => clearTimeout(timer)
  }, [fading])

  const floor = current.floor
  const rows = useMemo(() => agentSessionTranscriptRows(items, floor), [floor, items])
  return { rows, clearing: fading !== null, clears: current.clears }
}

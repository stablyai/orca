import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionContextClearOutstanding,
  agentSessionTranscriptRows,
  latestAgentSessionContextClearSequence
} from '../../../../../../shared/agent-session/agent-session-context-clear'

/** Matches the transcript's `duration-150` fade, so the swap happens while it is invisible. */
export const NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS = 150

type ClearFloorState = {
  epoch: string | null
  /** The sequence the transcript starts from: its latest `/clear` divider, 0 for none. */
  floor: number
  /** A clear that landed live, waiting for the old transcript to fade out. */
  fading: number | null
  /** When the fade that `fading` waits on began, if this view's press began it. */
  fadedSince: number | null
  /** Bumped per live clear; keys the list so nothing the cleared transcript held carries over. */
  clears: number
  /** This view's /clear awaiting its divider: its press time and the newest row drawn then. */
  sent: { at: number; tail: number } | null
}

/** Show history after the latest clear; fade live clears before swapping, but preserve scroll for historical dividers.
 * A sent /clear fades the transcript at once: the host stops the old agent before its divider lands. */
export function useNativeChatContextClearFloor(
  epoch: string | null,
  items: readonly AgentJournalRenderItem[]
): {
  rows: readonly AgentJournalRenderItem[]
  clearing: boolean
  clears: number
  /** Call as this view's /clear goes out; the returned restore shows the transcript again if refused. */
  onClearSent: () => () => void
} {
  const latest = useMemo(() => latestAgentSessionContextClearSequence(items), [items])
  const [state, setState] = useState<ClearFloorState>(() => ({
    epoch,
    floor: latest,
    fading: null,
    fadedSince: null,
    clears: 0,
    sent: null
  }))
  // The newest row the last commit drew: a divider past it arrived live, not from an older page.
  const tail = items.at(-1)?.sequence ?? 0
  const drawnTail = useRef(tail)
  useEffect(() => {
    drawnTail.current = tail
  }, [tail])
  const onClearSent = useCallback(() => {
    const sent = { at: Date.now(), tail: drawnTail.current }
    setState((prior) => ({ ...prior, sent }))
    return () => setState((prior) => (prior.sent === sent ? { ...prior, sent: null } : prior))
  }, [])

  let current = state
  if (epoch !== state.epoch) {
    // A new journal (first read or a rewind) remounts the list on its own; nothing to fade or wait on.
    current = { ...state, epoch, floor: latest, fading: null, fadedSince: null, sent: null }
    setState(current)
  } else if (latest > (state.fading ?? state.floor)) {
    // A divider past the press answers it, so the press stops hiding anything.
    const { sent } = state
    const answered = sent !== null && latest > sent.tail
    const waiting = answered ? null : sent
    current =
      latest > drawnTail.current
        ? { ...state, fading: latest, fadedSince: answered ? sent.at : null, sent: waiting }
        : { ...state, floor: latest, sent: waiting }
    setState(current)
  } else if (
    state.sent !== null &&
    !agentSessionContextClearOutstanding(items, latest, state.sent.tail)
  ) {
    // No row the press hid is loaded any more (a snapshot past its divider).
    current = { ...state, sent: null }
    setState(current)
  }

  const { fading, fadedSince } = current
  // Held hidden until a divider newer than the press lands; a refused clear fades back in.
  const awaitingDivider = agentSessionContextClearOutstanding(
    items,
    latest,
    current.sent?.tail ?? null
  )
  useEffect(() => {
    if (fading === null) {
      return
    }
    // A press that already faded the transcript out swaps as soon as its divider lands.
    const elapsed = fadedSince === null ? 0 : Date.now() - fadedSince
    const timer = setTimeout(
      () =>
        setState((prior) =>
          prior.fading === fading
            ? { ...prior, floor: fading, fading: null, fadedSince: null, clears: prior.clears + 1 }
            : prior
        ),
      Math.max(0, NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS - elapsed)
    )
    return () => clearTimeout(timer)
  }, [fadedSince, fading])

  const floor = current.floor
  const rows = useMemo(() => agentSessionTranscriptRows(items, floor), [floor, items])
  return { rows, clearing: fading !== null || awaitingDivider, clears: current.clears, onClearSent }
}

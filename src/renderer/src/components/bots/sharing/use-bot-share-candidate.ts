import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'
import { type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import { prepareBotShare, settleBotShare, type BotShareSelection } from './bot-share-rpc'

export type BotShareCandidateState = {
  candidate: BotShareCandidateSummary | null
  selection: BotShareSelection
  /** The setup note on screen; it starts as the one the bot was last published with. */
  note: string
  setNote: (note: string) => void
  /** The shown candidate was built from the picks on screen; false while a later pick builds, or
   *  after it failed, so Publish never sends a candidate for other picks. */
  committed: boolean
  building: boolean
  error: string | null
  /** Builds the candidate again with these picks; the shown one stays until the new one is ready.
   *  Resolves to the new candidate, or null when the build failed or a later pick replaced it. */
  select: (change: Partial<BotShareSelection>) => Promise<BotShareCandidateSummary | null>
  /** Builds again from the bot as it is now, after the owner fixed a source file. */
  rebuild: () => void
}

/** The one candidate a Share dialog shows, and again on every changed pick. It is first built once
 *  `startFrom` is known: from the picks and note the bot was last published with (`last`), or from
 *  the defaults; null waits. */
export function useBotShareCandidate(
  listed: BotRef,
  startFrom: 'last' | 'defaults' | null
): BotShareCandidateState {
  const bot = useStableBotRef(listed)
  const [built, setBuilt] = useState<{
    candidate: BotShareCandidateSummary
    selection: BotShareSelection
  } | null>(null)
  // Memory is off unless named; every other absent list shares all of that part.
  const [selection, setSelection] = useState<BotShareSelection>({})
  const [note, setNoteState] = useState('')
  // A rebuild carries the note on screen, so its candidate digests as that publish would.
  const noteRef = useRef('')
  const [building, setBuilding] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const setNote = useCallback((next: string) => {
    noteRef.current = next
    setNoteState(next)
  }, [])

  const build = useCallback(
    async (next: BotShareSelection, last = false): Promise<BotShareCandidateSummary | null> => {
      const current = ++generation.current
      setBuilding(true)
      setError(null)
      const result = await settleBotShare(
        prepareBotShare(bot, next, last ? { last: true } : { setupNote: noteRef.current })
      )
      if (generation.current !== current) {
        return null
      }
      setBuilding(false)
      if (!result.ok) {
        setError(result.error)
        return null
      }
      const picked = result.value.last?.selection ?? next
      if (result.value.last) {
        setSelection(picked)
        setNote(result.value.last.setupNote)
      }
      setBuilt({ candidate: result.value.candidate, selection: picked })
      return result.value.candidate
    },
    [bot, setNote]
  )

  // The first known start sticks: a link read later (say, after a publish) keeps the picks on screen.
  const [begin, setBegin] = useState<'last' | 'defaults' | null>(startFrom)
  if (begin === null && startFrom !== null) {
    setBegin(startFrom)
  }
  useEffect(() => {
    if (begin === null) {
      return
    }
    void build({}, begin === 'last')
    return () => {
      generation.current += 1
    }
  }, [build, begin])

  const select = (change: Partial<BotShareSelection>): Promise<BotShareCandidateSummary | null> => {
    const next = { ...selection, ...change }
    setSelection(next)
    return build(next)
  }

  return {
    candidate: built?.candidate ?? null,
    selection,
    note,
    setNote,
    committed:
      built !== null && !building && JSON.stringify(built.selection) === JSON.stringify(selection),
    building,
    error,
    select,
    rebuild: () => void build(selection)
  }
}

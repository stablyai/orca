import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'
import { type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
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
   *  A pick lists the skills this dialog last listed; `fresh` (a publish retry) reads them again,
   *  with its note. Resolves to the new candidate, or null when the build failed or a later pick
   *  replaced it. */
  select: (
    change: Partial<BotShareSelection>,
    fresh?: { setupNote: string }
  ) => Promise<BotShareCandidateSummary | null>
  /** Builds again from the bot as it is now, after the owner fixed a source file. */
  rebuild: () => void
}

type CandidateSource = 'last' | 'defaults' | 'local'

export function useBotShareCandidate(
  listed: BotRef,
  startFrom: CandidateSource
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
  const noteEdited = useRef(false)
  const [building, setBuilding] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  // This dialog's skill listing on the bot's host: kept for its picks, never shared with another.
  const [skillsSession] = useState(createNonSecureContextUuid)

  const setNote = useCallback((next: string) => {
    noteRef.current = next
    setNoteState(next)
  }, [])

  const build = useCallback(
    async (
      next: BotShareSelection,
      source: CandidateSource,
      setupNote?: string,
      reuseSkills = false
    ): Promise<BotShareCandidateSummary | null> => {
      const current = ++generation.current
      setBuilding(true)
      setError(null)
      const result = await settleBotShare(
        prepareBotShare(
          bot,
          next,
          source === 'last'
            ? { last: true, skillsSession }
            : {
                setupNote: setupNote ?? noteRef.current,
                skillsSession,
                ...(source === 'local' ? { localOnly: true } : {}),
                ...(reuseSkills ? { reuseSkills: true } : {})
              }
        )
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
        if (!noteEdited.current) {
          setNote(result.value.last.setupNote)
        }
      }
      setBuilt({ candidate: result.value.candidate, selection: picked })
      return result.value.candidate
    },
    [bot, setNote, skillsSession]
  )

  const [begin, setBegin] = useState(startFrom)
  const [hasReadLink, setHasReadLink] = useState(startFrom !== 'local')
  if (!hasReadLink && startFrom !== 'local') {
    setHasReadLink(true)
    if (startFrom === 'last' && Object.keys(selection).length === 0) {
      setBegin('last')
      setBuilt(null)
      setBuilding(true)
      setError(null)
    }
  }
  useEffect(() => {
    void build({}, begin)
    return () => {
      generation.current += 1
    }
  }, [build, begin])

  const source = startFrom === 'local' ? 'local' : 'defaults'
  const select = (
    change: Partial<BotShareSelection>,
    fresh?: { setupNote: string }
  ): Promise<BotShareCandidateSummary | null> => {
    const next = { ...selection, ...change }
    setSelection(next)
    return fresh ? build(next, source, fresh.setupNote) : build(next, source, undefined, true)
  }

  return {
    candidate: built?.candidate ?? null,
    selection,
    note,
    setNote: (next) => {
      noteEdited.current = true
      setNote(next)
    },
    committed:
      built !== null &&
      !building &&
      !error &&
      JSON.stringify(built.selection) === JSON.stringify(selection),
    building,
    error,
    select,
    rebuild: () => void build(selection, !built && begin === 'last' ? 'last' : source)
  }
}

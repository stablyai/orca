import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Input } from '../ui/input'

type RepoTextDraft = { repoId: string; text: string }

// Why: updateRepo persists via async IPC before the store value updates, so a
// store-controlled input resets mid-IME-composition (Hangul decomposes into
// jamo). Keep keystrokes in local draft state; persist per-keystroke except
// while an IME composition is active (see composingRef below).
export function RepoSettingsDraftInput({
  repoId,
  storeValue,
  onTextChange,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  ...inputProps
}: {
  repoId: string
  storeValue: string
  onTextChange: (text: string) => void
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>): React.JSX.Element {
  const [draft, setDraft] = useState<RepoTextDraft>({ repoId, text: storeValue })
  const pendingStoreEchoesRef = useRef<string[]>([])
  // Why: IME composition (e.g. Japanese kana→kanji conversion) fires input
  // events for unconfirmed text. Persisting those mid-composition writes the
  // pre-confirmation value to the store and its async echo can cancel the
  // composition. Hold persistence until compositionend so only confirmed text
  // reaches updateRepo.
  const composingRef = useRef(false)
  // Why: some IMEs emit a trailing change event after compositionend that
  // repeats the already-persisted confirmed value; consume that one change so
  // the value is not persisted twice.
  const skipNextChangeRef = useRef<string | null>(null)
  // Why: the blur/unmount flush below must not re-persist text that a keystroke
  // or compositionend already committed. Track the last value handed to
  // onTextChange (and the store value we adopt) so the flush is a no-op unless a
  // composition was abandoned with genuinely unpersisted text.
  const lastPersistedRef = useRef(storeValue)

  const persist = (text: string): void => {
    pendingStoreEchoesRef.current.push(text)
    lastPersistedRef.current = text
    onTextChange(text)
  }

  useEffect(() => {
    setDraft((current) => {
      if (current.repoId !== repoId) {
        pendingStoreEchoesRef.current = []
        composingRef.current = false
        skipNextChangeRef.current = null
        lastPersistedRef.current = storeValue
        return { repoId, text: storeValue }
      }
      if (storeValue === current.text) {
        pendingStoreEchoesRef.current = []
        skipNextChangeRef.current = null
        lastPersistedRef.current = storeValue
        return current
      }
      const pendingEchoIndex = pendingStoreEchoesRef.current.indexOf(storeValue)
      if (pendingEchoIndex !== -1) {
        // Why: queued updateRepo calls can echo older input text after newer
        // keystrokes; accepting that echo re-cancels active IME composition.
        pendingStoreEchoesRef.current.splice(0, pendingEchoIndex + 1)
        return current
      }
      pendingStoreEchoesRef.current = []
      skipNextChangeRef.current = null
      lastPersistedRef.current = storeValue
      return { repoId, text: storeValue }
    })
  }, [repoId, storeValue])

  const text = draft.repoId === repoId ? draft.text : storeValue

  // Why: onChange keeps `draft` current even mid-composition, but persistence is
  // deliberately held until compositionend. If the field blurs or unmounts while
  // a composition is still active — e.g. the user types a Hangul syllable and
  // immediately navigates back out of project settings — no compositionend fires,
  // so that last syllable lives only in `draft` and never reaches the store.
  // Flush the visible draft on blur and on unmount so it is not lost. Guarded to
  // stay a no-op when the text was already persisted (keystroke/compositionend).
  const flushRef = useRef<() => void>(() => {})
  // Why: publish the flush closure from an effect (post-commit) rather than during
  // render, so a discarded concurrent render can never leave the blur/unmount flush
  // pointing at uncommitted draft state.
  useEffect(() => {
    flushRef.current = (): void => {
      if (draft.repoId !== repoId || draft.text === lastPersistedRef.current) {
        return
      }
      composingRef.current = false
      skipNextChangeRef.current = draft.text
      persist(draft.text)
    }
  })
  useEffect(() => () => flushRef.current(), [])

  return (
    <Input
      {...inputProps}
      value={text}
      onChange={(e) => {
        const nextText = e.target.value
        setDraft({ repoId, text: nextText })
        // Why: during composition the input stays live via draft, but the
        // unconfirmed text is not persisted until compositionend.
        if (composingRef.current) {
          return
        }
        if (skipNextChangeRef.current === nextText) {
          skipNextChangeRef.current = null
          return
        }
        skipNextChangeRef.current = null
        persist(nextText)
      }}
      onBlur={(e) => {
        flushRef.current()
        onBlur?.(e)
      }}
      onCompositionStart={(e) => {
        composingRef.current = true
        skipNextChangeRef.current = null
        onCompositionStart?.(e)
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false
        const nextText = e.currentTarget.value
        setDraft({ repoId, text: nextText })
        persist(nextText)
        // Why: cover IMEs that fire the final change after compositionend.
        skipNextChangeRef.current = nextText
        onCompositionEnd?.(e)
      }}
    />
  )
}

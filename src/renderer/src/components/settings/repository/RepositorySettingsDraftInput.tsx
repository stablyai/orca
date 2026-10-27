import type React from 'react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Input } from '../../ui/input'

type RepoTextDraft = { repoId: string; text: string }

// Async store echoes reset Hangul composition; keep local drafts and persist keystrokes only outside composition.
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
  // Hold unconfirmed IME input until compositionend; mid-composition persistence echoes can cancel conversion.
  const composingRef = useRef(false)
  // Consume final duplicate changes emitted after compositionend by some IMEs.
  const skipNextChangeRef = useRef<string | null>(null)
  // Track persisted text so blur/unmount flush saves only genuinely uncommitted composition.
  const lastPersistedRef = useRef(storeValue)

  const persist = (text: string): void => {
    pendingStoreEchoesRef.current.push(text)
    lastPersistedRef.current = text
    onTextChange(text)
  }

  // Decide after commit, not in render or a setDraft updater: React may re-run both, and the echo queue is consumed.
  const syncDraftFromStore = useEffectEvent((): void => {
    if (draft.repoId !== repoId) {
      pendingStoreEchoesRef.current = []
      composingRef.current = false
      skipNextChangeRef.current = null
      lastPersistedRef.current = storeValue
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setDraft({ repoId, text: storeValue })
      return
    }
    if (storeValue === draft.text) {
      pendingStoreEchoesRef.current = []
      skipNextChangeRef.current = null
      lastPersistedRef.current = storeValue
      return
    }
    const pendingEchoIndex = pendingStoreEchoesRef.current.indexOf(storeValue)
    if (pendingEchoIndex !== -1) {
      // Why: queued updateRepo calls can echo older input text after newer
      // keystrokes; accepting that echo re-cancels active IME composition.
      pendingStoreEchoesRef.current.splice(0, pendingEchoIndex + 1)
      return
    }
    pendingStoreEchoesRef.current = []
    skipNextChangeRef.current = null
    lastPersistedRef.current = storeValue
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setDraft({ repoId, text: storeValue })
  })
  useEffect(() => syncDraftFromStore(), [repoId, storeValue])

  const text = draft.repoId === repoId ? draft.text : storeValue

  // Blur/unmount may omit compositionend; flush the visible draft so abandoned composition text is not lost.
  const flushRef = useRef<() => void>(() => {})
  // Publish after commit so discarded renders cannot install a flush for uncommitted drafts.
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
        // Suppress the final duplicate change some IMEs emit after compositionend.
        skipNextChangeRef.current = nextText
        onCompositionEnd?.(e)
      }}
    />
  )
}

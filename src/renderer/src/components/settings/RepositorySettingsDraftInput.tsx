import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Input } from '../ui/input'

type RepoTextDraft = { repoId: string; text: string }

// Why: updateRepo persists via async IPC before the store value updates, so a
// store-controlled input resets mid-IME-composition (Hangul decomposes into
// jamo). Keep keystrokes in local draft state; persist stays per-keystroke.
export function RepoSettingsDraftInput({
  repoId,
  storeValue,
  onTextChange,
  ...inputProps
}: {
  repoId: string
  storeValue: string
  onTextChange: (text: string) => void
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>): React.JSX.Element {
  const [draft, setDraft] = useState<RepoTextDraft>({ repoId, text: storeValue })
  const pendingStoreEchoesRef = useRef<string[]>([])

  useEffect(() => {
    setDraft((current) => {
      if (current.repoId !== repoId) {
        pendingStoreEchoesRef.current = []
        return { repoId, text: storeValue }
      }
      if (storeValue === current.text) {
        pendingStoreEchoesRef.current = []
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
      return { repoId, text: storeValue }
    })
  }, [repoId, storeValue])

  const text = draft.repoId === repoId ? draft.text : storeValue
  return (
    <Input
      {...inputProps}
      value={text}
      onChange={(e) => {
        const nextText = e.target.value
        pendingStoreEchoesRef.current.push(nextText)
        setDraft({ repoId, text: nextText })
        onTextChange(nextText)
      }}
    />
  )
}

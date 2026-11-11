import type React from 'react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Input } from '../../ui/input'

type RepoTextDraft = { repoId: string; text: string }

export function useRepoSettingsTextDraft({
  repoId,
  storeValue,
  onTextChange
}: {
  repoId: string
  storeValue: string | undefined
  onTextChange: (text: string) => void
}) {
  const [draft, setDraft] = useState<RepoTextDraft>({ repoId, text: storeValue ?? '' })
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
  const lastStoreValueRef = useRef(storeValue)
  const syncDraftFromStore = useEffectEvent((): void => {
    if (storeValue === undefined) {
      return
    }
    if (draft.repoId === repoId && storeValue === lastStoreValueRef.current) {
      return
    }
    lastStoreValueRef.current = storeValue
    if (draft.repoId !== repoId) {
      pendingStoreEchoesRef.current = []
      composingRef.current = false
      skipNextChangeRef.current = null
      lastPersistedRef.current = storeValue
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setDraft({ repoId, text: storeValue ?? '' })
      return
    }
    if (composingRef.current) {
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
    setDraft({ repoId, text: storeValue ?? '' })
  })
  useEffect(() => syncDraftFromStore(), [repoId, storeValue])

  const text = draft.repoId === repoId ? draft.text : (storeValue ?? '')

  // Blur/unmount may omit compositionend; flush the visible draft so abandoned composition text is not lost.
  const flushRef = useRef<() => void>(() => {})
  // Publish after commit so discarded renders cannot install a flush for uncommitted drafts.
  useEffect(() => {
    flushRef.current = (): void => {
      if (
        draft.repoId !== repoId ||
        lastPersistedRef.current === undefined ||
        draft.text === lastPersistedRef.current
      ) {
        return
      }
      composingRef.current = false
      skipNextChangeRef.current = draft.text
      persist(draft.text)
    }
  })
  useEffect(() => () => flushRef.current(), [])

  return {
    value: text,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
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
    },
    onBlur: () => {
      flushRef.current()
    },
    onCompositionStart: () => {
      composingRef.current = true
      skipNextChangeRef.current = null
    },
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement>) => {
      composingRef.current = false
      const nextText = e.currentTarget.value
      setDraft({ repoId, text: nextText })
      persist(nextText)
      // Suppress the final duplicate change some IMEs emit after compositionend.
      skipNextChangeRef.current = nextText
    }
  }
}

type DraftInputProps = {
  repoId: string
  storeValue: string
  onTextChange: (text: string) => void
  controller?: ReturnType<typeof useRepoSettingsTextDraft>
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>
export function RepoSettingsDraftInput(props: DraftInputProps): React.JSX.Element {
  return props.controller ? (
    <DraftInputView {...props} controller={props.controller} />
  ) : (
    <LocalDraftInput {...props} />
  )
}
function LocalDraftInput(props: DraftInputProps): React.JSX.Element {
  const controller = useRepoSettingsTextDraft(props)
  return <DraftInputView {...props} controller={controller} />
}
function DraftInputView({
  repoId: _repoId,
  storeValue: _storeValue,
  onTextChange: _onTextChange,
  controller,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: DraftInputProps & {
  controller: ReturnType<typeof useRepoSettingsTextDraft>
}): React.JSX.Element {
  return (
    <Input
      {...props}
      {...controller}
      onBlur={(event) => {
        controller.onBlur()
        onBlur?.(event)
      }}
      onCompositionStart={(event) => {
        controller.onCompositionStart()
        onCompositionStart?.(event)
      }}
      onCompositionEnd={(event) => {
        controller.onCompositionEnd(event)
        onCompositionEnd?.(event)
      }}
    />
  )
}

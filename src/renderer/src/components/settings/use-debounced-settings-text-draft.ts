import { useCallback, useEffect, useRef, useState } from 'react'

// Matches the repository-hook script draft, the established debounce for settings text in this pane.
const SETTINGS_TEXT_COMMIT_DEBOUNCE_MS = 700

export type DebouncedSettingsTextDraft = {
  value: string
  onChange: (next: string) => void
  onBlur: () => void
}

/**
 * Local draft for a free-text setting, committed on a debounce and flushed on blur, unmount, and
 * window unload.
 *
 * Why: binding an `<Input>` straight to `updateSettings` sends one IPC round trip per keystroke,
 * and each one replaces the `settings` object identity in every other window, re-rendering every
 * component subscribed to it. The committed value is unchanged — only the number of commits is.
 *
 * A pending timer is the single source of truth for "the draft has uncommitted edits": `onChange`
 * is the only place that arms it and `flush` the only place that clears it, so there is no separate
 * dirty flag to fall out of sync.
 */
export function useDebouncedSettingsTextDraft(args: {
  value: string
  commit: (next: string) => void
}): DebouncedSettingsTextDraft {
  const { value, commit } = args
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(draft)
  const commitRef = useRef(commit)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Why an effect, not a render-time write: render must stay pure, and React can replay it.
  useEffect(() => {
    commitRef.current = commit
  }, [commit])

  // Why gated on a pending commit: an external write (another window, a reset) should land in the
  // field, but must not yank characters out from under someone mid-edit.
  useEffect(() => {
    if (timerRef.current !== null) {
      return
    }
    draftRef.current = value
    setDraft(value)
  }, [value])

  const flush = useCallback(() => {
    if (timerRef.current === null) {
      return
    }
    clearTimeout(timerRef.current)
    timerRef.current = null
    commitRef.current(draftRef.current)
  }, [])

  const onChange = useCallback(
    (next: string) => {
      draftRef.current = next
      setDraft(next)
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
      timerRef.current = setTimeout(flush, SETTINGS_TEXT_COMMIT_DEBOUNCE_MS)
    },
    [flush]
  )

  // Why unmount: closing the pane (or the settings search hiding the section) mid-word must persist
  // the same value typing it would have. `flush` has no dependencies, so this cleanup only ever runs
  // on unmount.
  // Why beforeunload: a window close or app quit never unmounts the tree, so the cleanup cannot run.
  // The close coordinator dispatches a synthetic beforeunload while the tree is still mounted so
  // listeners like this one can flush; `updateSettings` issues its IPC synchronously, ahead of the
  // close confirmation, so main persists the value before it flushes the store on quit.
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flush])

  return { value: draft, onChange, onBlur: flush }
}

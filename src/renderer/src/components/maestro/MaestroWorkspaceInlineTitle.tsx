import { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'

export function MaestroWorkspaceInlineTitle({
  title,
  onCommit,
  onCancel
}: {
  title: string
  onCommit: (title: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const finishedRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const finish = useCallback(() => {
    if (finishedRef.current) {
      return
    }
    finishedRef.current = true
    const nextTitle = draft.trim()
    if (nextTitle && nextTitle !== title) {
      onCommit(nextTitle)
      return
    }
    onCancel()
  }, [draft, onCancel, onCommit, title])

  const cancel = useCallback(() => {
    if (finishedRef.current) {
      return
    }
    finishedRef.current = true
    onCancel()
  }, [onCancel])

  return (
    <input
      ref={inputRef}
      value={draft}
      maxLength={512}
      autoComplete="off"
      aria-label={translate(
        'auto.components.maestro.MaestroWorkspaceWindow.inlineTitle',
        'Tab title'
      )}
      className="h-6 min-w-0 w-full rounded-md border border-ring/80 bg-background px-1.5 text-xs font-semibold leading-4 text-foreground shadow-[0_0_0_2px_color-mix(in_srgb,var(--ring)_18%,transparent)] outline-none"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={finish}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          finish()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
    />
  )
}

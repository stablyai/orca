import React, { useCallback, useRef, useState } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function CopyButton({
  text,
  title = 'Copy comment'
}: {
  text: string
  title?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after this row action unmounts; avoid
  // starting a reset timer that will outlive the component.
  const isMountedRef = useRef(false)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  const setCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void window.api.ui.writeClipboardText(text).then(() => {
        if (!isMountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
    },
    [clearCopiedResetTimer, text]
  )

  return (
    <button
      ref={setCopyButtonRef}
      className="p-1 rounded hover:bg-accent text-muted-foreground/40 hover:text-foreground transition-colors shrink-0"
      title={title}
      onClick={handleCopy}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

export function ResolveButton({
  threadId,
  isResolved,
  onResolve
}: {
  threadId: string
  isResolved: boolean
  onResolve: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
}): React.JSX.Element {
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setLoading(true)
      void Promise.resolve(onResolve(threadId, !isResolved)).finally(() => setLoading(false))
    },
    [threadId, isResolved, onResolve]
  )

  return (
    <span className="contents">
      {loading ? (
        <LoaderCircle className="size-3 animate-spin text-muted-foreground shrink-0" />
      ) : (
        <button
          className="text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent"
          onClick={handleClick}
        >
          {isResolved
            ? translate(
                'auto.components.right.sidebar.checks.panel.content.365254cc1b',
                'Unresolve'
              )
            : translate('auto.components.right.sidebar.checks.panel.content.0c96cd25e5', 'Resolve')}
        </button>
      )}
    </span>
  )
}

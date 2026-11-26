import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { DialogDescription } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

/** The command as a left-aligned inset block. Exact text gets an always-visible Copy; the preview
 *  keeps its ellipsis and has none. Long text scrolls inside, by keyboard as well. */
export function WorkerDockCommandBlock({
  text,
  exact,
  onCopy
}: {
  text: string
  exact: boolean
  onCopy: () => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const scroller = useRef<HTMLPreElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [blockFocused, setBlockFocused] = useState(false)
  const [copied, setCopied] = useState(false)
  const reset = useRef<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const hadExact = useRef(exact)
  // Only a withdrawal of the exact command moves focus, and only from a stop it took away: Copy
  // itself (focus is left on the page or the bare dialog), or the scroll area when the preview that
  // replaced the text fits and so is no longer a tab stop. A scroll area that still scrolls keeps
  // focus, and a resize alone never moves it. This runs before the overflow state re-measures, so
  // it measures the new text directly.
  useLayoutEffect(() => {
    const withdrawn = hadExact.current && !exact
    hadExact.current = exact
    const dialog = withdrawn ? root.current?.closest<HTMLElement>('[role="dialog"]') : null
    if (!dialog) {
      return
    }
    const block = scroller.current
    const active = document.activeElement
    const copyHadFocus = !active || active === document.body || active === dialog
    const blockStopGone =
      block !== null && active === block && block.scrollHeight <= block.clientHeight + 1
    if (copyHadFocus || blockStopGone) {
      dialog.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.focus()
    }
  }, [exact])
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) {
      return
    }
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  useEffect(
    () => () => {
      if (reset.current !== null) {
        window.clearTimeout(reset.current)
      }
    },
    []
  )
  const copy = useCallback(async () => {
    try {
      if (!(await onCopy())) {
        return
      }
      setCopied(true)
      if (reset.current !== null) {
        window.clearTimeout(reset.current)
      }
      reset.current = window.setTimeout(() => {
        reset.current = null
        setCopied(false)
      }, 1500)
    } catch {
      // Best effort: the clipboard can refuse while the window is unfocused.
    }
  }, [onCopy])
  const label = copied
    ? t('components.native-chat.copyMessage.copied', 'Copied')
    : t('components.native-chat.workerDock.copyCommand', 'Copy command')
  return (
    <div ref={root} className="relative min-w-0" data-worker-dock-command="">
      <DialogDescription asChild>
        <pre
          ref={scroller}
          // A tab stop while there is something to scroll, and for as long as it holds focus, so
          // a resize that makes it fit never drops focus; the next Tab moves on as usual.
          tabIndex={overflows || blockFocused ? 0 : undefined}
          onFocus={() => setBlockFocused(true)}
          onBlur={() => setBlockFocused(false)}
          className={cn(
            'max-h-[40vh] overflow-y-auto rounded-md bg-foreground/[0.035] p-2 text-left font-mono text-chat-code leading-[1.6] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] scrollbar-sleek focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-ring focus-visible:ring-inset',
            exact && 'pr-8'
          )}
        >
          {text}
        </pre>
      </DialogDescription>
      {exact ? (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={label}
          title={label}
          className={cn(
            // Centred on the block's right edge, the same column as the dialog's Close.
            'absolute top-1.5 -right-3 flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            copied && 'text-status-success'
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      ) : null}
    </div>
  )
}

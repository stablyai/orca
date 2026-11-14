import { useEffect, useEffectEvent, useMemo, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Quote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { addViewportSizeChangeListener } from '@/hooks/viewport-size-change-listener'
import { useTranslate } from '@/i18n/use-translate'

// Why: shown at once, a double-click's action would sit under the pointer and take the third click.
const DOUBLE_CLICK_SETTLE_MS = 500

type QuoteRequest = {
  text: string
  anchor: { getBoundingClientRect: () => DOMRect; contextElement?: Element }
}

export type QuotableSelection = { text: string; range: Range }

/** Offers "Add to chat" beside a settled selection inside `rootRef` that `readQuotable` accepts. */
export function SelectionAddToChatPopover({
  rootRef,
  enabled,
  readQuotable,
  onSelectionSettled,
  onAdd
}: {
  rootRef: RefObject<HTMLElement | null>
  enabled: boolean
  readQuotable: (root: HTMLElement) => QuotableSelection | null
  /** Runs once per changed selection, before the offer is read. */
  onSelectionSettled?: (root: HTMLElement) => void
  /** `button` is where the offer was clicked, for a surface that opens a menu from it. */
  onAdd: (text: string, button: DOMRect) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [request, setRequest] = useState<QuoteRequest | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const virtualRef = useMemo(() => ({ current: request?.anchor ?? null }), [request])
  // Why: inline callbacks must not re-install the document listeners every render.
  const readLatestQuotable = useEffectEvent(readQuotable)
  const settleSelection = useEffectEvent((root: HTMLElement) => onSelectionSettled?.(root))

  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !root) {
      return
    }
    let selectionChanged = false
    let timer: number | undefined
    // The offered text, mirrored here so a selection change can compare it outside a state updater.
    let offered: string | null = null
    const show = (next: QuoteRequest | null): void => {
      offered = next?.text ?? null
      setRequest(next)
    }
    const close = (): void => {
      window.clearTimeout(timer)
      show(null)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && contentRef.current?.contains(event.target)) {
        return
      }
      close()
      selectionChanged = false
    }
    // `point` is where the pointer was released; a keyboard selection is offered at its end.
    const offer = (point: { x: number; y: number } | null, delay = 0): void => {
      // A press or key that left the selection as it was (a scrollbar, a timestamp) selected nothing.
      if (!selectionChanged) {
        return
      }
      selectionChanged = false
      settleSelection(root)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const quotable = readLatestQuotable(root)
        if (!quotable) {
          show(null)
          return
        }
        const { text, range } = quotable
        const held = range.getBoundingClientRect()
        const end = [...range.getClientRects()].at(-1) ?? held
        const dx = (point?.x ?? end.right) - held.left
        const dy = (point?.y ?? end.top) - held.top
        show({
          text,
          anchor: {
            getBoundingClientRect: () => {
              const now = range.getBoundingClientRect()
              return new DOMRect(now.left + dx, now.top + dy)
            },
            // Why: lets the popover follow the text's scroller, and hide once it is clipped.
            contextElement: range.startContainer.parentElement ?? undefined
          }
        })
      }, delay)
    }
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button === 0) {
        offer(
          { x: event.clientX, y: event.clientY },
          event.detail === 2 ? DOUBLE_CLICK_SETTLE_MS : 0
        )
      }
    }
    const onKeyUp = (): void => offer(null)
    const onSelectionChange = (): void => {
      selectionChanged = true
      if (offered !== null && readLatestQuotable(root)?.text !== offered) {
        show(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', close)
    const removeResizeListener = addViewportSizeChangeListener(close)
    return () => {
      close()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', close)
      removeResizeListener()
    }
  }, [enabled, rootRef])

  return (
    <Popover open={request !== null} onOpenChange={(open) => !open && setRequest(null)}>
      <PopoverAnchor virtualRef={virtualRef} />
      {request ? (
        <PopoverContent
          ref={contentRef}
          align="start"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          hideWhenDetached
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // Keeps the selection, and the focus, where they are until the quote is taken.
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="p-0.5">
            <Button
              variant="ghost"
              size="xs"
              onClick={(event) => {
                const button = event.currentTarget.getBoundingClientRect()
                // Why: the composer refuses focus while an overlay, including this one, is open.
                // Taken or not (the composer may have locked since), the offer is spent.
                flushSync(() => setRequest(null))
                onAdd(request.text, button)
              }}
            >
              <Quote />
              {t('components.native-chat.addSelectionToChat', 'Add to chat')}
            </Button>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

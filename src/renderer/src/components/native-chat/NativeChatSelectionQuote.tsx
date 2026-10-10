import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { addViewportSizeChangeListener } from '@/hooks/viewport-size-change-listener'
import { translate } from '@/i18n/i18n'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  formatNativeChatQuote,
  readNativeChatQuotableSelection
} from './native-chat-quote-selection'

// Why: shown at once, a double-click's action would sit under the pointer and take the third click.
const DOUBLE_CLICK_SETTLE_MS = 500

/** The selected text, and the point the offer is drawn at, which moves with that text. */
type QuoteRequest = {
  text: string
  anchor: { getBoundingClientRect: () => DOMRect; contextElement?: Element }
}

/** Offers "Add to chat" beside a selection made in an agent's reply. */
export function NativeChatSelectionQuote({
  rootRef,
  composerRef,
  enabled
}: {
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  enabled: boolean
}): React.JSX.Element {
  const [request, setRequest] = useState<QuoteRequest | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const virtualRef = useMemo(() => ({ current: request?.anchor ?? null }), [request])

  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !root) {
      return
    }
    let selectionChanged = false
    let timer: number | undefined
    const close = (): void => {
      window.clearTimeout(timer)
      setRequest(null)
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
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        // Only offered where the text would land.
        const quotable = composerRef.current?.acceptsText()
          ? readNativeChatQuotableSelection(root)
          : null
        if (!quotable) {
          setRequest(null)
          return
        }
        const { text, range } = quotable
        const held = range.getBoundingClientRect()
        const end = [...range.getClientRects()].at(-1) ?? held
        const dx = (point?.x ?? end.right) - held.left
        const dy = (point?.y ?? end.top) - held.top
        setRequest({
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
      setRequest((current) =>
        current && readNativeChatQuotableSelection(root)?.text !== current.text ? null : current
      )
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
  }, [composerRef, enabled, rootRef])

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
              onClick={() => {
                // Taken or not (the composer may have locked since), the offer is spent.
                composerRef.current?.appendText(formatNativeChatQuote(request.text))
                setRequest(null)
              }}
            >
              <MessageSquarePlus />
              {translate('components.native-chat.addSelectionToChat', 'Add to chat')}
            </Button>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

import type { ComponentProps, PointerEvent } from 'react'
import { cn } from '@/lib/class-names'

// Gap between the composing text and the surface edge or the pressed point.
const PROXY_MARGIN_PX = 8

/** Remembers where the user last pressed the surface, which is where its text field usually is. */
export function recordComposingKeyboardProxyAnchor(event: PointerEvent<HTMLElement>): void {
  const rect = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dataset.tapX = String(event.clientX - rect.left)
  event.currentTarget.dataset.tapY = String(event.clientY - rect.top)
}

// Puts the composing text just under the last press, inside the surface.
function placeComposingKeyboardProxy(proxy: HTMLTextAreaElement): void {
  const surface = proxy.parentElement
  if (!surface) {
    return
  }
  const width = surface.clientWidth
  const height = surface.clientHeight
  const x = Number(surface.dataset.tapX ?? width / 2)
  const y = Number(surface.dataset.tapY ?? height * 0.75)
  const clamp = (value: number, max: number) =>
    Math.max(PROXY_MARGIN_PX, Math.min(value, max - PROXY_MARGIN_PX))
  proxy.style.left = `${clamp(x - proxy.offsetWidth / 2, width - proxy.offsetWidth)}px`
  proxy.style.top = `${clamp(y + PROXY_MARGIN_PX, height - proxy.offsetHeight)}px`
}

/**
 * The hidden editable a streamed surface focuses, so host input methods (Pinyin, Kotoeri, dead
 * keys) compose. While composing it shows as a chip under the last press, where the candidate
 * window anchors. Its parent is the surface and must be positioned.
 */
export function ComposingKeyboardProxy({
  className,
  onCompositionEnd,
  ...props
}: ComponentProps<'textarea'>): React.JSX.Element {
  return (
    <textarea
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      rows={1}
      tabIndex={-1}
      {...props}
      className={cn(
        'pointer-events-none absolute top-0 left-0 z-10 m-0 size-px resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none [field-sizing:content] data-[composing]:size-auto data-[composing]:max-w-[calc(100%-16px)] data-[composing]:rounded-md data-[composing]:border data-[composing]:border-border data-[composing]:bg-popover data-[composing]:px-2 data-[composing]:py-1 data-[composing]:text-sm data-[composing]:text-popover-foreground data-[composing]:caret-current data-[composing]:opacity-100 data-[composing]:shadow-floating',
        className
      )}
      onCompositionStart={(event) => {
        event.currentTarget.dataset.composing = ''
        placeComposingKeyboardProxy(event.currentTarget)
      }}
      onCompositionUpdate={(event) => placeComposingKeyboardProxy(event.currentTarget)}
      onCompositionEnd={(event) => {
        delete event.currentTarget.dataset.composing
        onCompositionEnd?.(event)
      }}
    />
  )
}

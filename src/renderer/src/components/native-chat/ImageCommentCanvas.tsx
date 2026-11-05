import {
  useRef,
  type PointerEvent,
  type Dispatch,
  type SetStateAction,
  type RefObject
} from 'react'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { PanZoomViewport } from '@/components/editor/use-pan-zoom-viewport'
import type { PanZoomSize } from '../../../../shared/pan-zoom-view'
import { imageCommentBadge, imageCommentPosition, type ImageCommentPin } from './image-comment-pins'

export function ImageCommentCanvas({
  size,
  panZoom,
  pins,
  setPins,
  selected,
  setSelected,
  saving,
  editorRef
}: {
  size: PanZoomSize | null
  panZoom: PanZoomViewport
  pins: ImageCommentPin[]
  setPins: Dispatch<SetStateAction<ImageCommentPin[]>>
  selected: string | null
  setSelected: Dispatch<SetStateAction<string | null>>
  saving: boolean
  editorRef: RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const offset = panZoom.offset
  const gesture = useRef<{ id: string | null; x: number; y: number; pin?: ImageCommentPin } | null>(
    null
  )
  const position = (event: PointerEvent<HTMLDivElement>, clamp = false) => {
    if (!size || !panZoom.offset) {
      return null
    }
    const rect = event.currentTarget.getBoundingClientRect()
    return imageCommentPosition(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      panZoom.offset,
      panZoom.scale,
      size,
      clamp
    )
  }
  const pointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.altKey || saving) {
      return
    }
    event.stopPropagation()
    if (!position(event)) {
      return
    }
    const id =
      event.target instanceof Element
        ? (event.target.closest('[data-image-comment-id]')?.getAttribute('data-image-comment-id') ??
          null)
        : null
    gesture.current = {
      id,
      x: event.clientX,
      y: event.clientY,
      pin: pins.find((item) => item.id === id)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (id) {
      setSelected(id)
    }
  }
  const pointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const start = gesture.current
    gesture.current = null
    if (!start) {
      return
    }
    event.stopPropagation()
    const point = start.pin ? dragPosition(event, start.pin, start.x, start.y) : position(event)
    if (!point) {
      return
    }
    if (start.id) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
        setPins((items) =>
          items.map((item) => (item.id === start.id ? { ...item, ...point } : item))
        )
      }
    } else if (
      pins.length < 99 &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4
    ) {
      const id = createBrowserUuid()
      setPins((items) => [...items, { id, ...point, comment: '' }])
      setSelected(id)
    }
    requestAnimationFrame(() => editorRef.current?.focus())
  }

  const dragPosition = (
    event: PointerEvent<HTMLDivElement>,
    pin: ImageCommentPin,
    x: number,
    y: number
  ) =>
    size
      ? imageCommentPosition(
          {
            x: (size.width * panZoom.scale * pin.x) / 100 + event.clientX - x,
            y: (size.height * panZoom.scale * pin.y) / 100 + event.clientY - y
          },
          { x: 0, y: 0 },
          panZoom.scale,
          size,
          true
        )
      : null

  return (
    <div
      className="absolute inset-0 cursor-crosshair"
      data-testid="image-comment-canvas"
      onPointerDown={pointerDown}
      onPointerUp={pointerUp}
      onPointerMove={(event) => {
        const start = gesture.current
        if (!start?.id || saving || event.altKey) {
          return
        }
        event.stopPropagation()
        const point = start.pin ? dragPosition(event, start.pin, start.x, start.y) : null
        if (point && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
          setPins((items) =>
            items.map((item) => (item.id === start.id ? { ...item, ...point } : item))
          )
        }
      }}
      onPointerCancel={() => {
        gesture.current = null
      }}
    >
      {size && offset
        ? pins.map((item, index) => {
            const width = size.width * panZoom.scale,
              height = size.height * panZoom.scale
            const target = { x: (width * item.x) / 100, y: (height * item.y) / 100 }
            const badge = imageCommentBadge(target, { width, height })
            return (
              <div key={item.id} className="contents">
                <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
                  <line
                    x1={offset.x + target.x}
                    y1={offset.y + target.y}
                    x2={offset.x + badge.x}
                    y2={offset.y + badge.y}
                    className="stroke-background"
                    strokeWidth={3}
                  />
                  <line
                    x1={offset.x + target.x}
                    y1={offset.y + target.y}
                    x2={offset.x + badge.x}
                    y2={offset.y + badge.y}
                    className="stroke-foreground"
                  />
                  <circle
                    cx={offset.x + target.x}
                    cy={offset.y + target.y}
                    r={3}
                    className="fill-foreground stroke-background"
                  />
                </svg>
                <button
                  type="button"
                  data-image-comment-id={item.id}
                  aria-label={translate(
                    'components.native-chat.imageComments.pin',
                    'Comment {{number}}',
                    { number: index + 1 }
                  )}
                  aria-pressed={selected === item.id}
                  className="absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background bg-foreground text-xs font-semibold text-background shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{
                    left: offset.x + badge.x,
                    top: offset.y + badge.y
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelected(item.id)
                    editorRef.current?.focus()
                  }}
                >
                  {index + 1}
                </button>
              </div>
            )
          })
        : null}
    </div>
  )
}

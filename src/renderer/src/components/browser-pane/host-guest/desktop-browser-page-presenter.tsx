import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { isNativeViewPointOccluded } from '@/lib/native-view-occlusion'
import { translate } from '@/i18n/i18n'
import type { DesktopBrowserViewInput } from '../../../../../shared/desktop-browser-view-input'
import type { DesktopBrowserPage } from './desktop-browser-page-registry'
import { useDesktopBrowserPageDrag } from './use-desktop-browser-page-drag'
import { useDesktopBrowserPageInput } from './use-desktop-browser-page-input'
import {
  presentDesktopBrowserPage,
  type DesktopBrowserPagePresentation
} from './desktop-browser-page-presentation'

type Modifiers = Extract<DesktopBrowserViewInput, { kind: 'key' }>['modifiers']
function modifiers(event: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): Modifiers {
  const values: Modifiers = []
  if (event.altKey) {
    values.push('Alt')
  }
  if (event.ctrlKey) {
    values.push('Control')
  }
  if (event.metaKey) {
    values.push('Meta')
  }
  if (event.shiftKey) {
    values.push('Shift')
  }
  return values
}

export function DesktopBrowserPagePresenter({
  page,
  content,
  scroller,
  state,
  focusRef,
  onDragOver,
  onDrop
}: {
  page: DesktopBrowserPage
  content: HTMLDivElement
  scroller: HTMLDivElement
  state: DesktopBrowserPagePresentation
  focusRef: MutableRefObject<HTMLElement | null>
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  const [frame, setFrame] = useState<string | null>(null)
  const [forwarded, setForwarded] = useState(false)
  const latest = useRef(state)
  const presenter = useRef<ReturnType<typeof presentDesktopBrowserPage> | null>(null)
  const element = useRef<HTMLTextAreaElement | null>(null)
  const capturedPointers = useRef(new Set<number>())
  const composing = useRef(false)
  const input = useDesktopBrowserPageInput({
    page,
    state: () => latest.current,
    owner: () => presenter.current
  })
  const inputRef = useRef(input)
  inputRef.current = input
  const releaseCapturedPointers = (): void => {
    const target = element.current
    if (target) {
      for (const pointerId of capturedPointers.current) {
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId)
        }
      }
    }
    capturedPointers.current.clear()
  }
  useDesktopBrowserPageDrag(state.active)
  useLayoutEffect(() => {
    latest.current = state
    presenter.current?.refresh()
  }, [state])
  useLayoutEffect(() => {
    const presentation = presentDesktopBrowserPage({
      page,
      content,
      scroller,
      state: () => latest.current,
      onFrame: setFrame,
      onMode: (value) => {
        setForwarded(value)
        inputRef.current.onMode(value)
        if (!value) {
          releaseCapturedPointers()
        }
      },
      onError: (error) => console.warn('[browser] presenting desktop page failed:', error)
    })
    presenter.current = presentation
    return () => {
      presentation.dispose()
      presenter.current = null
    }
  }, [page, content, scroller])
  const rawPoint = (event: {
    clientX: number
    clientY: number
  }): { x: number; y: number } | null => {
    const rect = content.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return null
    }
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    }
  }
  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    if (!forwarded || isNativeViewPointOccluded(event.clientX, event.clientY)) {
      return null
    }
    return rawPoint(event)
  }
  const pointer = (
    type: 'move' | 'down' | 'up',
    event: React.PointerEvent<HTMLTextAreaElement>
  ): void => {
    const location = type === 'up' ? rawPoint(event) : point(event)
    const button =
      event.button === 0
        ? 'left'
        : event.button === 1
          ? 'middle'
          : event.button === 2
            ? 'right'
            : 'none'
    if (type === 'up') {
      input.releasePointer(
        event.pointerId,
        location
          ? {
              kind: 'mouse',
              type: 'up',
              ...location,
              button,
              buttons: 0,
              modifiers: modifiers(event)
            }
          : undefined
      )
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      capturedPointers.current.delete(event.pointerId)
      return
    }
    if (!location) {
      return
    }
    event.preventDefault()
    const mouse: DesktopBrowserViewInput = {
      kind: 'mouse',
      type,
      ...location,
      button,
      buttons: event.buttons & 7,
      modifiers: modifiers(event)
    }
    if (type === 'down' && input.pressPointer(event.pointerId, mouse)) {
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      capturedPointers.current.add(event.pointerId)
    } else if (type === 'move') {
      input.send(mouse)
    }
  }
  useEffect(() => {
    const target = element.current
    if (!target) {
      return
    }
    const wheel = (event: WheelEvent): void => {
      const location = point(event)
      if (!location) {
        return
      }
      event.preventDefault()
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? content.clientHeight : 1
      input.send({
        kind: 'mouse',
        type: 'wheel',
        ...location,
        deltaX: event.deltaX * factor,
        deltaY: event.deltaY * factor,
        buttons: event.buttons & 7,
        modifiers: modifiers(event)
      })
    }
    target.addEventListener('wheel', wheel, { passive: false })
    return () => target.removeEventListener('wheel', wheel)
  })
  const keyboard = (type: 'down' | 'up', event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || composing.current || event.key === 'Process') {
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      return
    }
    const eventInput: DesktopBrowserViewInput = {
      kind: 'key',
      type,
      key: event.key,
      code: event.code || event.key,
      modifiers: modifiers(event)
    }
    if (type === 'down' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key.length === 1) {
        eventInput.text = event.key
      } else if (event.key === 'Enter') {
        eventInput.text = '\r'
      } else if (event.key === 'Tab') {
        eventInput.text = '\t'
      }
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      if (type === 'down') {
        input.pressKey(eventInput, input.checkpoint())
      } else {
        input.releaseKey(eventInput)
      }
      return
    }
    // Window listeners must consume chrome shortcuts before guest input is dispatched.
    const inputCheckpoint = input.checkpoint()
    queueMicrotask(() => {
      if (!event.nativeEvent.defaultPrevented) {
        if (type === 'down') {
          input.pressKey(eventInput, inputCheckpoint)
        } else {
          input.releaseKey(eventInput)
        }
      }
    })
  }
  return (
    <div className="absolute inset-0 overflow-hidden" onDragOver={onDragOver} onDrop={onDrop}>
      {frame ? (
        <img
          src={frame}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full max-w-none"
        />
      ) : null}
      <textarea
        ref={(node) => {
          element.current = node
          focusRef.current = node
        }}
        aria-label={translate('browser.pageContent', 'Browser page')}
        tabIndex={state.active && !state.inputLocked && !state.hidden ? 0 : -1}
        className="absolute inset-0 size-full resize-none opacity-0 outline-none"
        disabled={!state.active || state.inputLocked || state.hidden}
        onFocus={() => {
          if (!forwarded) {
            void Promise.resolve(page.surface.focus()).catch(() => {})
          }
        }}
        onPointerDown={(event) => pointer('down', event)}
        onPointerMove={(event) => pointer('move', event)}
        onPointerUp={(event) => pointer('up', event)}
        onPointerCancel={(event) => {
          input.releasePointer(event.pointerId)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          capturedPointers.current.delete(event.pointerId)
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => keyboard('down', event)}
        onKeyUp={(event) => keyboard('up', event)}
        onBlur={() => {
          input.flush()
          releaseCapturedPointers()
        }}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          input.send({ kind: 'composition', text: event.data })
          event.currentTarget.value = ''
        }}
        onInput={(event) => {
          if (!composing.current) {
            event.currentTarget.value = ''
          }
        }}
        onPaste={(event) => {
          event.preventDefault()
          input.send({ kind: 'text', text: event.clipboardData.getData('text/plain') })
        }}
        spellCheck={false}
      />
    </div>
  )
}

import type { Terminal } from '@xterm/xterm'

type MouseSelectionForcingEvent = Pick<
  MouseEvent,
  'type' | 'button' | 'altKey' | 'ctrlKey' | 'defaultPrevented' | 'metaKey' | 'shiftKey'
>

type MouseSelectionForcingOptions = {
  copyOnSelect: boolean
  isMac: boolean
  mouseTrackingMode: Terminal['modes']['mouseTrackingMode']
}

function hasSelectionModifier(
  event: Pick<MouseEvent, 'altKey' | 'shiftKey'>,
  isMac: boolean
): boolean {
  return isMac ? event.altKey : event.shiftKey
}

export function shouldForceCopyOnSelectMouseSelection(
  event: MouseSelectionForcingEvent,
  options: MouseSelectionForcingOptions
): boolean {
  if (event.defaultPrevented || !options.copyOnSelect || options.mouseTrackingMode === 'none') {
    return false
  }
  if (event.type !== 'mousedown' || event.button !== 0) {
    return false
  }
  if (event.ctrlKey || event.metaKey || hasSelectionModifier(event, options.isMac)) {
    return false
  }
  return true
}

export function createForcedSelectionMouseEvent(event: MouseEvent, isMac: boolean): MouseEvent {
  return new MouseEvent(event.type, {
    altKey: isMac ? true : event.altKey,
    bubbles: true,
    button: event.button,
    buttons: event.buttons,
    cancelable: true,
    clientX: event.clientX,
    clientY: event.clientY,
    composed: event.composed,
    ctrlKey: event.ctrlKey,
    detail: event.detail,
    metaKey: event.metaKey,
    screenX: event.screenX,
    screenY: event.screenY,
    shiftKey: isMac ? event.shiftKey : true,
    view: event.view
  })
}

export function isXtermScreenMouseTarget(target: EventTarget | null): target is Element {
  return target instanceof Element && target.closest('.xterm-screen') !== null
}

export function installCopyOnSelectMouseSelectionForcing(args: {
  container: HTMLElement
  getCopyOnSelect: () => boolean
  isMac: boolean
  terminal: Pick<Terminal, 'modes'>
}): () => void {
  let redispatching = false
  const onMouseDown = (event: MouseEvent): void => {
    if (redispatching) {
      return
    }
    const target = event.target
    if (!isXtermScreenMouseTarget(target)) {
      return
    }
    if (
      !shouldForceCopyOnSelectMouseSelection(event, {
        copyOnSelect: args.getCopyOnSelect(),
        isMac: args.isMac,
        mouseTrackingMode: args.terminal.modes.mouseTrackingMode
      })
    ) {
      return
    }

    // Why: xterm disables its selection service when a TUI enables mouse
    // reporting. Re-dispatching with the platform's existing force-selection
    // modifier lets xterm's own selection/copy path run instead of sending the
    // drag to the TUI.
    event.preventDefault()
    event.stopImmediatePropagation()
    const forcedEvent = createForcedSelectionMouseEvent(event, args.isMac)
    redispatching = true
    try {
      target.dispatchEvent(forcedEvent)
    } finally {
      redispatching = false
    }
  }

  args.container.addEventListener('mousedown', onMouseDown, { capture: true })
  return () => {
    args.container.removeEventListener('mousedown', onMouseDown, { capture: true })
  }
}

// Why: app shortcut owners and terminal panes both listen on window capture, so React's
// effect order decided who saw a chord first (STA-11205). The router is installed before
// React renders and runs every app owner, in registration order, ahead of any pane listener.

type AppKeyEventType = 'keydown' | 'keyup'
type AppKeyListener = (event: KeyboardEvent) => void
type Registration = { listener: AppKeyListener; active: boolean }

const registrations: Record<AppKeyEventType, Registration[]> = { keydown: [], keyup: [] }
let installedOn: Window | null = null

function dispatch(type: AppKeyEventType, event: KeyboardEvent): void {
  // Why: like native listeners, owners added during a dispatch first see the next event.
  const snapshot = registrations[type].slice()
  let stoppedImmediately = false
  const originalStop = event.stopImmediatePropagation
  // Why: only an immediate stop ends the app stage; plain stopPropagation still lets the
  // remaining window owners run, as it did when each owner was its own window listener.
  event.stopImmediatePropagation = () => {
    stoppedImmediately = true
    originalStop.call(event)
  }
  try {
    for (const registration of snapshot) {
      if (stoppedImmediately) {
        break
      }
      if (!registration.active) {
        continue
      }
      try {
        registration.listener(event)
      } catch (error) {
        // Why: a throwing owner must not cost the rest their shortcuts, as with native listeners.
        reportError(error)
      }
    }
  } finally {
    event.stopImmediatePropagation = originalStop
  }
}

const onKeyDown = (event: KeyboardEvent): void => dispatch('keydown', event)
const onKeyUp = (event: KeyboardEvent): void => dispatch('keyup', event)

/** Call before React renders so the router's window listeners precede every pane's. */
export function installAppKeyboardRouter(target: Window = window): void {
  if (installedOn === target) {
    return
  }
  installedOn?.removeEventListener('keydown', onKeyDown, { capture: true })
  installedOn?.removeEventListener('keyup', onKeyUp, { capture: true })
  target.addEventListener('keydown', onKeyDown, { capture: true })
  target.addEventListener('keyup', onKeyUp, { capture: true })
  installedOn = target
}

/** Window-capture key listener for app shortcut owners; terminal panes keep their own. */
export function addAppKeyListener(type: AppKeyEventType, listener: AppKeyListener): void {
  installAppKeyboardRouter(installedOn ?? window)
  const list = registrations[type]
  if (list.some((registration) => registration.active && registration.listener === listener)) {
    return
  }
  list.push({ listener, active: true })
}

export function removeAppKeyListener(type: AppKeyEventType, listener: AppKeyListener): void {
  const list = registrations[type]
  const index = list.findIndex(
    (registration) => registration.active && registration.listener === listener
  )
  if (index === -1) {
    return
  }
  list[index].active = false
  list.splice(index, 1)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    installedOn?.removeEventListener('keydown', onKeyDown, { capture: true })
    installedOn?.removeEventListener('keyup', onKeyUp, { capture: true })
    installedOn = null
  })
}

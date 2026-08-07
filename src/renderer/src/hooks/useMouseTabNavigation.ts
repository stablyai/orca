import { useEffect } from 'react'
import { handleSwitchTabAcrossAllTypes } from './ipc-tab-switch'

const MOUSE_BACK_BUTTON = 3
const MOUSE_FORWARD_BUTTON = 4

function resolveMouseSideButtonDirection(event: MouseEvent): -1 | 1 | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null
  }
  if (event.button === MOUSE_BACK_BUTTON) {
    return -1
  }
  if (event.button === MOUSE_FORWARD_BUTTON) {
    return 1
  }
  return null
}

export function useMouseTabNavigation(): void {
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      const direction = resolveMouseSideButtonDirection(event)
      if (direction === null) {
        return
      }
      event.preventDefault()
      handleSwitchTabAcrossAllTypes(direction)
    }

    const consumeSideButtonDefault = (event: MouseEvent): void => {
      if (resolveMouseSideButtonDirection(event) !== null) {
        event.preventDefault()
      }
    }

    // Why: browsers treat side buttons as history navigation; capture and
    // consume each mouse phase before webviews or terminal handlers see it.
    window.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('mouseup', consumeSideButtonDefault, { capture: true })
    window.addEventListener('auxclick', consumeSideButtonDefault, { capture: true })
    return () => {
      window.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('mouseup', consumeSideButtonDefault, { capture: true })
      window.removeEventListener('auxclick', consumeSideButtonDefault, { capture: true })
    }
  }, [])
}

export type RemoteBrowserPointerButton = 'left' | 'middle'

export type RemoteBrowserPointerModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

export type RemoteBrowserPointerSample = {
  pointerId: number
  x: number
  y: number
  button: RemoteBrowserPointerButton
  modifiers: RemoteBrowserPointerModifier[]
}

export type RemoteBrowserPointerCommand =
  | {
      method: 'browser.mouseClick'
      params: {
        x: number
        y: number
        button: RemoteBrowserPointerButton
        modifiers: RemoteBrowserPointerModifier[]
      }
    }
  | {
      method: 'browser.mouseMove'
      params: { x: number; y: number }
    }
  | {
      method: 'browser.mouseDown' | 'browser.mouseUp'
      params: { button: RemoteBrowserPointerButton }
    }

const REMOTE_BROWSER_DRAG_THRESHOLD_PX = 6

export async function executeRemoteBrowserPointerCommands(
  commands: readonly RemoteBrowserPointerCommand[],
  deps: {
    isCurrent: () => boolean
    send: (command: RemoteBrowserPointerCommand) => Promise<void>
    release: (button: RemoteBrowserPointerButton) => void
  }
): Promise<boolean> {
  let pressedButton: RemoteBrowserPointerButton | null = null
  try {
    for (const command of commands) {
      if (!deps.isCurrent()) {
        return false
      }
      if (command.method === 'browser.mouseDown') {
        pressedButton = command.params.button
      }
      await deps.send(command)
      if (command.method === 'browser.mouseUp') {
        pressedButton = null
      }
    }
    return true
  } finally {
    if (pressedButton) {
      deps.release(pressedButton)
    }
  }
}

export function isRemoteBrowserPointerDrag(
  start: RemoteBrowserPointerSample,
  end: Pick<RemoteBrowserPointerSample, 'pointerId' | 'x' | 'y'>
): boolean {
  return (
    start.pointerId === end.pointerId &&
    Math.hypot(end.x - start.x, end.y - start.y) > REMOTE_BROWSER_DRAG_THRESHOLD_PX
  )
}

export function getRemoteBrowserPointerCommands(
  start: RemoteBrowserPointerSample,
  end: Pick<RemoteBrowserPointerSample, 'pointerId' | 'x' | 'y'>
): RemoteBrowserPointerCommand[] | null {
  if (start.pointerId !== end.pointerId) {
    return null
  }
  const isDrag = isRemoteBrowserPointerDrag(start, end)
  if (!isDrag) {
    return [
      {
        method: 'browser.mouseClick',
        params: {
          x: end.x,
          y: end.y,
          button: start.button,
          modifiers: start.modifiers
        }
      }
    ]
  }
  return [
    { method: 'browser.mouseMove', params: { x: start.x, y: start.y } },
    { method: 'browser.mouseDown', params: { button: start.button } },
    { method: 'browser.mouseMove', params: { x: end.x, y: end.y } },
    { method: 'browser.mouseUp', params: { button: start.button } }
  ]
}

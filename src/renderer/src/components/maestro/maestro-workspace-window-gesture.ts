import type { MaestroWorkspaceWindowPlacement } from './maestro-workspace-window-layout'

export function startMaestroWorkspaceWindowGesture(
  event: React.PointerEvent,
  worldZoom: number,
  placement: MaestroWorkspaceWindowPlacement,
  kind: 'move' | 'resize',
  onCommit: (delta: { x: number; y: number }) => void
): void {
  event.preventDefault()
  event.stopPropagation()
  const target = event.currentTarget
  const windowElement = target.closest<HTMLElement>('[data-maestro-workspace-surface]')
  if (!windowElement) {
    return
  }
  const gesturePreview = windowElement.querySelector<HTMLElement>(
    '[data-maestro-workspace-gesture-preview]'
  )
  const origin = { x: event.clientX, y: event.clientY }
  const total = { x: 0, y: 0 }
  let moveFrame: number | null = null
  target.setPointerCapture(event.pointerId)
  const paintGesture = (): void => {
    moveFrame = null
    if (!gesturePreview) {
      return
    }
    gesturePreview.style.opacity = '1'
    if (kind === 'move') {
      gesturePreview.style.transform = `translate(${total.x}px, ${total.y}px)`
    } else {
      const width = Math.max(240, placement.size.width + total.x)
      const height = Math.max(150, placement.size.height + total.y)
      gesturePreview.style.transform = `scale(${width / placement.size.width}, ${height / placement.size.height})`
    }
  }
  const move: EventListener = (moveEvent): void => {
    if (!(moveEvent instanceof PointerEvent)) {
      return
    }
    const delta = {
      x: (moveEvent.clientX - origin.x) / worldZoom,
      y: (moveEvent.clientY - origin.y) / worldZoom
    }
    total.x += delta.x
    total.y += delta.y
    if (moveFrame === null) {
      moveFrame = requestAnimationFrame(paintGesture)
    }
    origin.x = moveEvent.clientX
    origin.y = moveEvent.clientY
  }
  const finish = (): void => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', finish)
    target.removeEventListener('pointercancel', finish)
    if (moveFrame !== null) {
      cancelAnimationFrame(moveFrame)
    }
    paintGesture()
    if (total.x !== 0 || total.y !== 0) {
      onCommit(total)
    }
    requestAnimationFrame(() => {
      if (gesturePreview) {
        gesturePreview.style.opacity = ''
        gesturePreview.style.transform = ''
      }
    })
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', finish)
  target.addEventListener('pointercancel', finish)
}

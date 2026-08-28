import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import {
  clampPetSize,
  type PetAgentAnimation,
  type PetWindowPosition
} from '../../../../shared/pet-types'
import { PET_WINDOW_MARGIN } from '../../../../shared/pet-window-geometry'
import { applyPetPointerAnimation } from './pet-agent-state'
import { PetCharacter } from './PetCharacter'
import { usePetPointerInteraction } from './usePetPointerInteraction'

/** The agent animation relayed from the main window, replayed on mount. */
function useRelayedPetAnimation(): PetAgentAnimation {
  const [animation, setAnimation] = useState<PetAgentAnimation>('idle')
  useEffect(() => {
    const off = window.api.desktopPet.onAnimation(setAnimation)
    window.api.desktopPet.requestAnimation().catch(console.error)
    return off
  }, [])
  return animation
}

/** Mirror the persisted pet selection into this window's own store so `usePetUrl` resolves the
 *  same pet as the main window. Main broadcasts ui:stateChanged to every window. */
function usePetUIStateSync(): void {
  useEffect(() => {
    const hydrate = useAppStore.getState().hydratePersistedUI
    const off = window.api.ui.onStateChanged((ui) => hydrate(ui))
    window.api.ui
      .get()
      .then((ui) => hydrate(ui))
      .catch(console.error)
    return off
  }, [])
}

/** The pet window is a square with transparent corners. Hand the mouse back to whatever is
 *  behind it unless the pointer is actually over the pet, so the pet never blocks a click. */
function useMouseThrough(petRef: React.RefObject<HTMLDivElement | null>, dragging: boolean): void {
  // Why: seeded true because a fresh BrowserWindow does take mouse events — the mount effect
  // below must actually send the first "stop taking them", not dedupe it away.
  const interactiveRef = useRef(true)
  const setInteractive = useCallback((next: boolean): void => {
    if (interactiveRef.current === next) {
      return
    }
    interactiveRef.current = next
    window.api.desktopPet.setInteractive(next).catch(console.error)
  }, [])

  useEffect(() => {
    setInteractive(false)
    const onMove = (event: MouseEvent): void => {
      // Why: a drag must keep the mouse even when the pointer outruns the window mid-fling.
      if (dragging) {
        setInteractive(true)
        return
      }
      const rect = petRef.current?.getBoundingClientRect()
      setInteractive(
        !!rect &&
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
      )
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      setInteractive(true)
    }
  }, [dragging, petRef, setInteractive])
}

export function DesktopPetRoot(): React.JSX.Element {
  usePetUIStateSync()
  const size = clampPetSize(useAppStore((s) => s.petSize))
  const agentAnimation = useRelayedPetAnimation()
  const petRef = useRef<HTMLDivElement | null>(null)

  // Why: the pet is pinned inside its own window, so the drag's "position" is the window's
  // own screen origin and moving it is an OS window move, not a CSS offset.
  const windowOrigin = useCallback(
    (): PetWindowPosition => ({ x: window.screenX, y: window.screenY }),
    []
  )
  const interaction = usePetPointerInteraction(
    windowOrigin,
    (next) => {
      window.api.desktopPet.move({ x: next.x, y: next.y }).catch(console.error)
    },
    'screen'
  )
  useMouseThrough(petRef, interaction.dragging)

  const animationName = applyPetPointerAnimation(agentAnimation, interaction)

  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-transparent"
      style={{ padding: PET_WINDOW_MARGIN }}
    >
      {/* Why: the hit test measures THIS box, which shrink-wraps the sprite — measuring the
          full-window box would make every transparent corner swallow clicks. */}
      <div ref={petRef} data-desktop-pet-hit-area className="flex h-fit w-fit">
        <PetCharacter size={size} animationName={animationName} interaction={interaction} />
      </div>
    </div>
  )
}

export default DesktopPetRoot

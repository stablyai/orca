import { useEffect, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { usePetUrl } from './usePetUrl'
import { DetectedSpriteFrame, SpriteFrame } from './pet-sprite-frames'
import type { PetAnimationName } from './pet-agent-state'
import type { PetPointerInteraction } from './usePetPointerInteraction'

// Why: the bob float is runtime CSS, not user-visible copy; keep CSS keywords
// out of i18n so translated locales cannot invalidate the keyframes.
const PET_BOB_KEYFRAMES_CSS =
  '@keyframes pet-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }'

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  )
  useEffect(() => {
    const onChange = (): void => {
      setVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/** The pet itself: sprite playback plus the bob float and grab hit area. Shared by the in-window
 *  overlay and the detached desktop window, which differ only in how they position and move it. */
export function PetCharacter({
  size,
  animationName,
  interaction,
  className
}: {
  size: number
  animationName: PetAnimationName
  interaction: PetPointerInteraction
  className?: string
}): React.JSX.Element {
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const { url, sprite, detected } = usePetUrl()
  const { dragging, dragAnimation, dragGeneration, handlers } = interaction

  const motionAllowed = documentVisible && !reducedMotion
  // Why: a still/vertical grab freezes on frame 0 (Codex grab-and-hold); a
  // horizontal drag keeps animating so the running rows show. Bob always pauses.
  const spriteAnimate = motionAllowed && (!dragging || dragAnimation !== null)
  const bobAnimate = motionAllowed && !dragging

  return (
    <div
      {...handlers}
      className={`flex h-fit w-fit select-none ${className ?? ''}`}
      style={{
        cursor: dragging ? 'grabbing' : 'grab',
        animation: 'pet-bob 1.2s ease-in-out infinite',
        animationPlayState: bobAnimate ? 'running' : 'paused',
        touchAction: 'none',
        // Why: floor so the wrapper stays grabbable while w-fit/h-fit would
        // otherwise collapse to 0×0 during the image-load window.
        minWidth: 24,
        minHeight: 24
      }}
    >
      <style>{PET_BOB_KEYFRAMES_CSS}</style>
      {sprite ? (
        // Why: remount per pet so a switched-to sprite starts a fresh
        // animation instead of inheriting the prior pet's currentTime.
        <SpriteFrame
          key={url}
          url={url}
          sprite={sprite}
          animate={spriteAnimate}
          maxSize={size}
          animationName={animationName}
          restartKey={dragGeneration}
        />
      ) : detected ? (
        <DetectedSpriteFrame detected={detected} animate={spriteAnimate} maxSize={size} />
      ) : (
        // Why: cap explicitly at the pet size — the w-fit/h-fit wrapper is
        // fit-content, so max-w/h-full has no fixed box to resolve against
        // and the image would otherwise render at its intrinsic size and
        // overflow the persisted size box that clamping still assumes.
        <img
          src={url}
          alt=""
          className="max-h-full max-w-full object-contain"
          style={{ maxWidth: size, maxHeight: size }}
          draggable={false}
        />
      )}
    </div>
  )
}

import type React from 'react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'

type ServerRestartButtonProps = {
  /** Resting label, e.g. "Update all", "Update" or "Retry". */
  label: string
  /** Armed label in the same spot, e.g. "Restart 2?" or "Restart?". */
  armedLabel: string
  /** The full question, read as the armed button's name, e.g. "Restart 2 servers? Live sessions may drop." */
  question: string
  armed: boolean
  /** Nothing to restart right now: the button can't arm. */
  disabled: boolean
  /** Armed, but the update can't start yet (its fresh check is still running). */
  confirmBlocked?: boolean
  disabledReason?: string
  /** The full host name, shown on hover and keyboard focus. */
  target?: string
  /** Resting accessible name when the visible label alone is ambiguous, e.g. "Update build-box". */
  restingName?: string
  describedBy?: string
  onArm: () => void
  /** Must be stable (useCallback): the armed listeners re-subscribe when it changes. */
  onDisarm: () => void
  onConfirm: () => void
}

/**
 * Updating restarts servers, so the first click only arms: the same button asks "Restart N?" and
 * waits for a second click. Esc, a click anywhere else, or moving focus away reverts it.
 */
export function ServerRestartButton({
  label,
  armedLabel,
  question,
  armed,
  disabled,
  confirmBlocked = false,
  disabledReason,
  target,
  restingName,
  describedBy,
  onArm,
  onDisarm,
  onConfirm
}: ServerRestartButtonProps): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!armed) {
      return
    }
    const doc = ref.current?.ownerDocument ?? document
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) {
        onDisarm()
      }
    }
    // Capture Esc to revert before bubbling can close Settings, as the SSH target list does. Esc
    // that ends an IME composition, or belongs to a menu or dialog on top, is left to that layer.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || hasVisibleOverlay()) {
        return
      }
      event.preventDefault()
      onDisarm()
    }
    doc.addEventListener('pointerdown', onPointerDown, true)
    doc.addEventListener('keydown', onKeyDown, true)
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown, true)
      doc.removeEventListener('keydown', onKeyDown, true)
    }
  }, [armed, onDisarm])

  const button = (
    <Button
      ref={ref}
      type="button"
      variant={armed ? 'default' : 'outline'}
      size="sm"
      disabled={!armed && disabled}
      aria-label={armed ? question : restingName}
      aria-disabled={(armed && confirmBlocked) || undefined}
      aria-busy={(armed && confirmBlocked) || undefined}
      aria-describedby={describedBy}
      aria-description={!armed && disabled ? disabledReason : undefined}
      title={!armed && disabled ? disabledReason : undefined}
      onBlur={() => {
        if (armed) {
          onDisarm()
        }
      }}
      onKeyDown={(event) => {
        // A held Enter repeats clicks; only a fresh press may confirm.
        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
        }
        if (
          armed &&
          event.key === 'Escape' &&
          !event.nativeEvent.isComposing &&
          // Same guard as the capture handler: a menu or dialog on top owns Esc.
          !hasVisibleOverlay()
        ) {
          // Revert here only; Esc must not also leave Settings.
          event.preventDefault()
          event.stopPropagation()
          onDisarm()
        }
      }}
      onClick={(event) => {
        if (!armed) {
          onArm()
          return
        }
        // The second click of a double-click is not a deliberate confirmation.
        if (event.detail > 1 || confirmBlocked) {
          return
        }
        onConfirm()
      }}
    >
      {armed ? armedLabel : label}
    </Button>
  )

  return (
    <>
      {target === undefined ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className="max-w-xs break-words">
            {target}
          </TooltipContent>
        </Tooltip>
      )}
      <span className="sr-only" aria-live="polite">
        {armed ? question : ''}
      </span>
    </>
  )
}

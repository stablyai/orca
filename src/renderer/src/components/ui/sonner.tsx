import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon
} from 'lucide-react'
import { useEffect, useRef, type RefObject, type SyntheticEvent } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { useAppStore } from '@/store'
import {
  isModalLockedToastTarget,
  isModalOverlayOpen,
  syncToastModalLockAttributes
} from '@/lib/toast-modal-lock'
import { NOTIFICATION_CARD_STACK_HEIGHT_VAR } from '@/lib/notification-card-stack-height'
import { NOTIFICATION_CARD_STACK_BOTTOM } from '@/lib/notification-card-composer-clearance'
import { useNotificationCardLayoutVarReader } from '@/lib/notification-card-layout-vars'

// Why: a short outcome reads best with its action beside it; the toaster's default wraps actions below.
export const INLINE_ACTION_CLASS_NAMES = {
  content: '!basis-0',
  actionButton: '!m-0 !self-center'
}

// Pointerdown outside a Radix modal dismisses it or moves focus, so every toast press is shielded.
function shieldModalFromToastPointerDown(event: SyntheticEvent): void {
  const target = event.target
  if (
    target instanceof Element &&
    target.closest('[data-sonner-toast]') !== null &&
    isModalOverlayOpen(target)
  ) {
    event.preventDefault()
    event.stopPropagation()
  }
}

// Default-deny: only close and modal-safe controls run while a modal owns the interaction lock.
function blockModalToastInteraction(event: SyntheticEvent): void {
  if (event.target instanceof Element && isModalLockedToastTarget(event.target)) {
    event.preventDefault()
    event.stopPropagation()
  }
}

function useToastModalLockAttributes(wrapperRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) {
      return
    }
    const sync = (): void => syncToastModalLockAttributes(wrapper)
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(wrapper, { childList: true, subtree: true })
    // installBodyOverlayAttributes mirrors modal open/close onto this attribute.
    observer.observe(wrapper.ownerDocument.body, {
      attributes: true,
      attributeFilter: ['data-modal-overlay-open']
    })
    return () => observer.disconnect()
  }, [wrapperRef])
}

const TOASTER_OFFSET = {
  bottom: `calc(${NOTIFICATION_CARD_STACK_BOTTOM} + env(safe-area-inset-bottom, 0px) + var(${NOTIFICATION_CARD_STACK_HEIGHT_VAR}, 0px))`,
  // Why 1rem: the cards' right edge, so a toast above them lines up instead of jutting left.
  right: '1rem'
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAppStore((s) => s.settings?.theme) || 'system'
  const wrapperRef = useRef<HTMLDivElement>(null)
  useNotificationCardLayoutVarReader(wrapperRef)
  useToastModalLockAttributes(wrapperRef)

  return (
    <div
      ref={wrapperRef}
      onPointerDownCapture={shieldModalFromToastPointerDown}
      onClickCapture={blockModalToastInteraction}
      onAuxClickCapture={blockModalToastInteraction}
      onContextMenuCapture={blockModalToastInteraction}
    >
      <Sonner
        theme={theme as ToasterProps['theme']}
        position="bottom-right"
        // Clear the status bar, then any notification cards in this corner, at both breakpoints.
        offset={TOASTER_OFFSET}
        mobileOffset={TOASTER_OFFSET}
        className="toaster group"
        icons={{
          success: <CircleCheckIcon className="size-4" />,
          info: <InfoIcon className="size-4" />,
          warning: <TriangleAlertIcon className="size-4" />,
          error: <OctagonXIcon className="size-4" />,
          loading: <Loader2Icon className="size-4 animate-spin" />
        }}
        style={
          {
            '--normal-bg': 'var(--popover)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--border)',
            '--border-radius': 'var(--radius)',
            '--width': 'min(26rem, calc(100vw - 2rem))'
          } as React.CSSProperties
        }
        {...props}
      />
    </div>
  )
}

export { Toaster }

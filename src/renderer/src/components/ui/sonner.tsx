import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon
} from 'lucide-react'
import type { SyntheticEvent } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { useAppStore } from '@/store'
import { MODAL_OVERLAY_CHILD_SELECTOR } from '@/lib/body-overlay-attributes'
import { NOTIFICATION_CARD_STACK_HEIGHT_VAR } from '@/lib/notification-card-stack-height'
import { NOTIFICATION_CARD_STACK_BOTTOM } from '@/lib/notification-card-composer-clearance'

// Why: a short outcome reads best with its action beside it; the toaster's default wraps actions below.
export const INLINE_ACTION_CLASS_NAMES = {
  content: '!basis-0',
  actionButton: '!m-0 !self-center'
}

// Why: scope to real modals; Radix menus/selects also set body pointer-events:none.
function isModalOverlayOpen(element: Element): boolean {
  return element.ownerDocument.body.querySelector(MODAL_OVERLAY_CHILD_SELECTOR) !== null
}

function blockModalToastInteraction(event: SyntheticEvent): void {
  const target = event.target
  if (
    target instanceof Element &&
    target.closest('[data-sonner-toast]') !== null &&
    target.closest('[data-close-button]') === null &&
    isModalOverlayOpen(target)
  ) {
    event.preventDefault()
    event.stopPropagation()
  }
}

const TOASTER_OFFSET = {
  bottom: `calc(${NOTIFICATION_CARD_STACK_BOTTOM} + env(safe-area-inset-bottom, 0px) + var(${NOTIFICATION_CARD_STACK_HEIGHT_VAR}, 0px))`,
  // Why 1rem: the cards' right edge, so a toast above them lines up instead of jutting left.
  right: '1rem'
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAppStore((s) => s.settings?.theme) || 'system'

  return (
    <div
      onPointerDownCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-close-button]') &&
          isModalOverlayOpen(event.target)
        ) {
          // Toast interactions must not reach the backdrop or move modal focus.
          event.preventDefault()
          event.stopPropagation()
        } else {
          blockModalToastInteraction(event)
        }
      }}
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

import * as React from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

import { useResolvedPortalContainer } from '@/components/ui/portal-container-context'
import { cn } from '@/lib/utils'

function TooltipProvider({
  delayDuration = 0,
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  // Why: app tooltips are non-interactive labels. Letting the floating
  // content keep itself open can block the controls it is describing.
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ref: consumerRef,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const cleanupRef = React.useRef<(() => void) | null>(null)

  // Why: Radix never sees a trigger pointerleave when focus jumps windows, so replay it on view blur to run its own close (also cancels a pending delayed open).
  const setTriggerNode = React.useCallback(
    (node: HTMLButtonElement | null) => {
      // Why: React 19 refs may return a cleanup — retain it so unmount still
      // releases consumer resources even though no call site passes one today.
      const consumerCleanup = typeof consumerRef === 'function' ? consumerRef(node) : undefined
      if (consumerRef && typeof consumerRef !== 'function') {
        consumerRef.current = node
      }
      cleanupRef.current?.()
      cleanupRef.current = null
      const view = node?.ownerDocument?.defaultView
      if (!node || !view || view.closed) {
        if (typeof consumerCleanup === 'function') {
          cleanupRef.current = consumerCleanup
        }
        return
      }
      const closeOnViewBlur = (): void => {
        if (node.isConnected) {
          node.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
        }
      }
      view.addEventListener('blur', closeOnViewBlur)
      cleanupRef.current = () => {
        if (typeof consumerCleanup === 'function') {
          consumerCleanup()
        }
        view.removeEventListener('blur', closeOnViewBlur)
      }
    },
    [consumerRef]
  )

  React.useEffect(() => () => cleanupRef.current?.(), [])

  return <TooltipPrimitive.Trigger ref={setTriggerNode} data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  showArrow = true,
  children,
  portalContainer,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  showArrow?: boolean
  portalContainer?: HTMLElement | null
}) {
  const resolvedContainer = useResolvedPortalContainer(portalContainer)

  return (
    <TooltipPrimitive.Portal container={resolvedContainer}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // Why: tooltip portals can be triggered from inside menus/popovers.
        // Keep labels above those floating surfaces instead of hidden behind them.
        className={cn(
          'pointer-events-none z-[90] w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className
        )}
        {...props}
      >
        {children}
        {showArrow ? (
          <TooltipPrimitive.Arrow className="size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
        ) : null}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }

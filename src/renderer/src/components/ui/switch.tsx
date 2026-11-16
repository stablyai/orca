import * as React from 'react'
import * as SwitchPrimitive from 'radix-ui/switch'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/class-names'

const trackClassName =
  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30'
const thumbClassName =
  'pointer-events-none block size-3.5 translate-x-0 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-4'
const compactTrackClassName = 'h-3.5 w-6 border-0 p-0.5'
const compactThumbClassName = 'size-2.5 data-[state=checked]:translate-x-2.5'

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: 'default' | 'compact'
  thumbClassName?: string
  /**
   * A change waiting to finish: a spinner in the thumb. `turning-on` also shows the track half on,
   * for a switch shown On before that value is saved.
   */
  pending?: 'turning-on' | 'saving'
}

function Switch({
  className,
  size = 'default',
  thumbClassName: thumbClasses,
  pending,
  ...props
}: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        trackClassName,
        size === 'compact' && compactTrackClassName,
        'cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
        pending === 'turning-on' && 'data-[state=checked]:bg-foreground/45',
        className
      )}
      aria-busy={pending ? true : undefined}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          thumbClassName,
          size === 'compact' && compactThumbClassName,
          pending && 'flex items-center justify-center',
          thumbClasses
        )}
      >
        {pending ? (
          <Loader2
            aria-hidden="true"
            className={cn(
              'animate-spin text-muted-foreground motion-reduce:animate-none',
              size === 'compact' ? 'size-2' : 'size-2.5'
            )}
          />
        ) : null}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}

type SwitchIndicatorProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  checked: boolean
  size?: 'default' | 'compact'
  thumbClassName?: string
}

function SwitchIndicator({
  checked,
  className,
  size = 'default',
  thumbClassName: thumbClasses,
  ...props
}: SwitchIndicatorProps) {
  const state = checked ? 'checked' : 'unchecked'
  return (
    <span
      aria-hidden="true"
      data-slot="switch-indicator"
      data-state={state}
      className={cn(trackClassName, size === 'compact' && compactTrackClassName, className)}
      {...props}
    >
      <span
        data-slot="switch-thumb"
        data-state={state}
        className={cn(thumbClassName, size === 'compact' && compactThumbClassName, thumbClasses)}
      />
    </span>
  )
}

export { Switch, SwitchIndicator }

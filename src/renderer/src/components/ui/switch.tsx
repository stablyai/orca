import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

const trackClassName =
  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30'
const thumbClassName =
  'pointer-events-none block size-3.5 translate-x-0 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-4'
const compactTrackClassName = 'h-3.5 w-6 border-0 p-0.5'
const compactThumbClassName = 'size-2.5 data-[state=checked]:translate-x-2.5'

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
  thumbClassName?: string
}

function Switch({ className, thumbClassName: thumbClasses, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        trackClassName,
        'cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(thumbClassName, thumbClasses)}
      />
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

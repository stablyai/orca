import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>): React.ReactElement {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        'data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        className={cn(
          'block size-4 rounded-full border border-primary/40 bg-background shadow-sm',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:pointer-events-none disabled:opacity-50'
        )}
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }

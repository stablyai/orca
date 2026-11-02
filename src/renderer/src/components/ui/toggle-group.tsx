'use client'

import * as React from 'react'
import type { VariantProps } from 'class-variance-authority'
import * as ToggleGroupPrimitive from 'radix-ui/toggle-group'

import { cn } from '@/lib/utils'
import { toggleVariants } from '@/components/ui/toggle'

type ToggleGroupVariantProps = Omit<VariantProps<typeof toggleVariants>, 'variant'> & {
  variant?: VariantProps<typeof toggleVariants>['variant'] | 'segmented-card'
}

const ToggleGroupContext = React.createContext<
  ToggleGroupVariantProps & {
    spacing?: number
  }
>({
  size: 'default',
  variant: 'default',
  spacing: 0
})

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  ToggleGroupVariantProps & {
    spacing?: number
  }) {
  const contextValue = React.useMemo(() => ({ variant, size, spacing }), [variant, size, spacing])

  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      style={{ '--gap': spacing } as React.CSSProperties}
      className={cn(
        'group/toggle-group flex w-fit items-center gap-[--spacing(var(--gap))] rounded-md data-[spacing=default]:data-[variant=outline]:shadow-xs',
        variant === 'segmented-card' && 'grid w-full grid-cols-2 rounded-md bg-muted p-0.5',
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={contextValue}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & ToggleGroupVariantProps) {
  const context = React.useContext(ToggleGroupContext)
  const selectedVariant = context.variant || variant

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={selectedVariant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        toggleVariants({
          variant: selectedVariant === 'segmented-card' ? 'default' : selectedVariant,
          size: context.size || size
        }),
        'w-auto min-w-0 shrink-0 px-3 focus:z-10 focus-visible:z-10 data-[size=xs]:px-2',
        'data-[spacing=0]:rounded-none data-[spacing=0]:shadow-none data-[spacing=0]:first:rounded-l-md data-[spacing=0]:last:rounded-r-md data-[spacing=0]:data-[variant=outline]:border-l-0 data-[spacing=0]:data-[variant=outline]:first:border-l',
        selectedVariant === 'segmented-card' &&
          'h-7 rounded-sm border-0 bg-transparent shadow-none hover:bg-card/70 data-[state=on]:bg-card data-[state=on]:text-card-foreground data-[state=on]:shadow-xs',
        className
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem }

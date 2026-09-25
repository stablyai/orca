import type { ComponentProps, JSX, ReactNode } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'

/** Shared two-column tip layout: copy and actions on the left, a feature visual on the right. */
export function FeatureTipDialogFrame({
  open,
  onOpenChange,
  onOpenAutoFocus,
  visual,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenAutoFocus: ComponentProps<typeof DialogContent>['onOpenAutoFocus']
  visual: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background))] p-0 dark:bg-[color-mix(in_srgb,var(--foreground)_16%,var(--background))] sm:max-w-4xl md:!h-[min(27rem,calc(100vh-2rem))] md:!flex-row"
        showCloseButton
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <div className="scrollbar-sleek flex min-h-0 min-w-0 flex-1 flex-col justify-between overflow-y-auto px-8 py-9 md:shrink-0 md:basis-1/2">
          {children}
        </div>
        <div className="flex min-h-0 min-w-0 shrink-0 self-stretch overflow-hidden bg-muted/60 md:basis-1/2 md:border-l md:border-border/70">
          <div className="h-full min-h-[23rem] w-full md:w-[29.4rem]">{visual}</div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

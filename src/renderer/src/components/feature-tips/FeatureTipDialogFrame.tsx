import type { ComponentProps, JSX, ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
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

export function FeatureTipEyebrow({ label }: { label: string }): JSX.Element {
  return (
    <Badge
      variant="outline"
      className="mb-3 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
    >
      {label.toUpperCase()}
    </Badge>
  )
}

/** A muted "Change it anytime in Settings → X." line whose link leaves the tip for Settings. */
export function FeatureTipSettingsLine({
  lead,
  link,
  onClick
}: {
  lead: string
  link: string
  onClick: () => void
}): JSX.Element {
  return (
    <span className="block text-muted-foreground">
      {lead}{' '}
      <button
        type="button"
        onClick={onClick}
        className="inline appearance-none border-0 bg-transparent p-0 font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:decoration-foreground"
      >
        {link}
      </button>
      .
    </span>
  )
}

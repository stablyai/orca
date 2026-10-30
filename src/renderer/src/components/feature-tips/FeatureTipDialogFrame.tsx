import type { ComponentProps, JSX, ReactNode } from 'react'
import { Trans } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { i18n } from '@/i18n/i18n'
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
        surface="feature-tip"
        className="!flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-4xl md:!h-[min(27rem,calc(100vh-2rem))] md:!flex-row"
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
/** `text` is one translated sentence whose `<link>` span opens the related settings. */
export function FeatureTipSettingsLine({
  text,
  onClick
}: {
  text: string
  onClick: () => void
}): JSX.Element {
  return (
    <span className="block text-muted-foreground">
      <Trans
        i18n={i18n}
        defaults={text}
        components={{
          link: (
            <button
              type="button"
              onClick={onClick}
              className="inline appearance-none border-0 bg-transparent p-0 font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:decoration-foreground"
            />
          )
        }}
      />
    </span>
  )
}

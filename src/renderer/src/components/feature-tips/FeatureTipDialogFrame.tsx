import type { ComponentProps, JSX, ReactNode } from 'react'
import { Trans } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { i18n } from '@/i18n/i18n'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'

// Side by side, the outer edge of the primary button's 3px focus ring sits on the bottom of the
// visual's centered 22rem card; the column is the frame less its 1px borders.
export const FEATURE_TIP_BUTTONS_ON_CARD_EDGE =
  'md:pb-[calc((min(27rem,100vh-2rem)-2px-22rem)/2+3px)]'

/** Shared two-column tip layout: copy and actions on the left, a feature visual on the right. */
export function FeatureTipDialogFrame({
  open,
  onOpenChange,
  onOpenAutoFocus,
  visual,
  copyClassName,
  wide = false,
  scope,
  outside,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenAutoFocus: ComponentProps<typeof DialogContent>['onOpenAutoFocus']
  visual: ReactNode
  /** Adjusts the copy column, e.g. its padding, for one tip. */
  copyClassName?: string
  /** A larger frame for a visual that needs the room; nothing in it is clipped at the dialog's edge. */
  wide?: boolean
  /** Names the tip on the dialog (`data-feature-tip`), for a stylesheet of its own. */
  scope?: string
  /** Drawn on the dialog itself, outside its columns, e.g. figures over its edge. */
  outside?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        surface="feature-tip"
        className={cn(
          '!flex max-h-[calc(100vh-2rem)] flex-col sm:max-w-4xl md:!flex-row',
          wide
            ? 'sm:max-w-[min(63rem,calc(100%-2rem))] md:!h-[min(30.5rem,calc(100vh-2rem))]'
            : 'overflow-hidden md:!h-[min(27rem,calc(100vh-2rem))]'
        )}
        data-feature-tip={scope}
        showCloseButton
        onOpenAutoFocus={onOpenAutoFocus}
      >
        {outside}
        <div
          className={cn(
            'scrollbar-sleek flex min-h-0 min-w-0 flex-1 flex-col justify-between overflow-y-auto px-8 py-9 md:shrink-0 md:basis-1/2',
            copyClassName
          )}
        >
          {children}
        </div>
        <div
          className={cn(
            'flex min-h-0 min-w-0 shrink-0 self-stretch overflow-hidden bg-muted/60 md:basis-1/2 md:border-l md:border-border/70',
            // Without the dialog's own clip, the visual keeps to its rounded corners.
            wide && 'rounded-b-[7px] md:rounded-l-none md:rounded-r-[7px]'
          )}
        >
          <div
            className={cn('h-full min-h-[23rem] w-full', wide ? 'md:w-[33rem]' : 'md:w-[29.4rem]')}
          >
            {visual}
          </div>
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

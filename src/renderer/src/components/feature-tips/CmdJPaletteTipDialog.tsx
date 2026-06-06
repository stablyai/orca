import type { JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { CmdJPaletteFeatureTipVisual } from './CmdJPaletteFeatureTipVisual'
import { FeatureTipActions } from './FeatureTipActions'

export function CmdJPaletteTipDialog({
  open,
  tip,
  primaryBusy,
  onOpenChange,
  onPrimaryAction,
  onSkip,
  onRebindClick
}: {
  open: boolean
  tip: FeatureTip
  primaryBusy: boolean
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSkip: () => void
  onRebindClick: () => void
}): JSX.Element {
  // Why: match the horizontal layout (text left, visual/animation right) used by the
  // CLI tip for a consistent "feature education" presentation; keeps the palette demo
  // prominent on the right.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background))] p-0 dark:bg-[color-mix(in_srgb,var(--foreground)_16%,var(--background))] sm:max-w-4xl md:!h-[min(27rem,calc(100vh-2rem))] md:!flex-row"
        showCloseButton
      >
        <div className="scrollbar-sleek flex min-h-0 min-w-0 flex-1 flex-col justify-between overflow-y-auto px-8 py-9 md:shrink-0 md:basis-[47.5%]">
          <DialogHeader className="gap-4 text-left">
            <div>
              <DialogTitle className="text-3xl font-semibold leading-tight tracking-tight max-w-[22rem]">
                {tip.title}
              </DialogTitle>
              <DialogDescription className="mt-3 max-w-2xl text-sm leading-relaxed">
                {tip.description}
              </DialogDescription>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Rebind the shortcut anytime in{' '}
                <button
                  type="button"
                  onClick={onRebindClick}
                  className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:decoration-foreground"
                >
                  Settings → Shortcuts
                </button>
                .
              </p>
            </div>
          </DialogHeader>

          <DialogFooter className="mt-8 flex sm:justify-stretch">
            <FeatureTipActions
              currentTip={tip}
              primaryBusy={primaryBusy}
              onPrimaryAction={onPrimaryAction}
              onSkip={onSkip}
              showSkip={false}
              fullWidth
            />
          </DialogFooter>
        </div>
        <div className="min-h-0 min-w-0 shrink-0 overflow-hidden md:basis-[52.5%]">
          <div className="h-full md:w-[29.4rem]">
            <CmdJPaletteFeatureTipVisual />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

import type { JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { formatShortcutLabel, useShortcutLabel } from '@/hooks/useShortcutLabel'
import { CmdJPaletteFeatureTipVisual } from './CmdJPaletteFeatureTipVisual'
import { FeatureTipActions } from './FeatureTipActions'
import { translate } from '@/i18n/i18n'

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
  // Why: read the live binding so the title chip stays correct after a rebind
  // and on Linux/Windows (Ctrl+Shift+J) — matching the visual's key chips.
  const worktreePaletteShortcutLabel = useShortcutLabel('worktree.palette')
  const displayShortcutLabel =
    worktreePaletteShortcutLabel !== 'Unassigned'
      ? worktreePaletteShortcutLabel
      : formatShortcutLabel('worktree.palette')
  // The tip's title uses "<shortcut>" as a placeholder token; split it so we
  // can render the live label as a styled <kbd> chip inline. Missing token
  // degrades to the plain title.
  const titleParts = tip.title.split('<shortcut>')
  const titlePrefix = titleParts[0]
  const titleSuffix = titleParts.slice(1).join('<shortcut>')

  // Why: match the horizontal layout (text left, visual/animation right) used by the
  // CLI tip for a consistent "feature education" presentation; keeps the palette demo
  // prominent on the right.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background))] p-0 dark:bg-[color-mix(in_srgb,var(--foreground)_16%,var(--background))] sm:max-w-4xl md:!h-[min(27rem,calc(100vh-2rem))] md:!flex-row"
        showCloseButton
        // Why: Radix auto-focuses the first focusable child; without this the
        // inline rebind link in the description gets the focus ring on open.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="scrollbar-sleek flex min-h-0 min-w-0 flex-1 flex-col justify-between overflow-y-auto px-8 py-9 md:shrink-0 md:basis-1/2">
          <DialogHeader className="gap-4 text-left">
            <div>
              {/* Why: uppercase eyebrow reads as a category label, not a feature launch. */}
              <Badge
                variant="outline"
                className="mb-3 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
              >
                {tip.eyebrow.toUpperCase()}
              </Badge>
              <DialogTitle className="text-2xl font-semibold leading-tight tracking-tight md:text-[1.75rem]">
                <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 md:flex-nowrap">
                  <span>{titlePrefix.trimEnd()}</span>
                  {displayShortcutLabel ? (
                    <kbd className="inline-flex shrink-0 items-center rounded-md border border-border bg-card px-2 py-0.5 font-mono text-base font-medium text-foreground">
                      {displayShortcutLabel}
                    </kbd>
                  ) : null}
                  {titleSuffix ? <span>{titleSuffix}</span> : null}
                </span>
              </DialogTitle>
              <DialogDescription className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed">
                <span className="block">{tip.description}</span>
                <span className="block text-muted-foreground">
                  {translate("auto.components.feature.tips.CmdJPaletteTipDialog.8241897205", "Rebind the shortcut anytime in")}{' '}
                  <button
                    type="button"
                    onClick={onRebindClick}
                    className="inline appearance-none border-0 bg-transparent p-0 font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:decoration-foreground"
                  >
                    {translate("auto.components.feature.tips.CmdJPaletteTipDialog.c0bb9f869b", "Settings → Shortcuts")}</button>
                  .
                </span>
              </DialogDescription>
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
        <div className="flex min-h-0 min-w-0 shrink-0 self-stretch overflow-hidden bg-muted/60 md:basis-1/2 md:border-l md:border-border/70">
          <div className="h-full min-h-[23rem] w-full md:w-[29.4rem]">
            <CmdJPaletteFeatureTipVisual />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

import type { JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatShortcutLabel, useShortcutLabel } from '@/hooks/useShortcutLabel'
import { CmdJPaletteFeatureTipVisual } from './CmdJPaletteFeatureTipVisual'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'
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
  // Use the live binding for rebindings and platform-specific shortcuts.
  const worktreePaletteShortcutLabel = useShortcutLabel('worktree.palette')
  const displayShortcutLabel =
    worktreePaletteShortcutLabel !== 'Unassigned'
      ? worktreePaletteShortcutLabel
      : formatShortcutLabel('worktree.palette')
  // Split the translated placeholder to render the shortcut as an inline key chip.
  const titleParts = tip.title.split('<shortcut>')
  const titlePrefix = titleParts[0]
  const titleSuffix = titleParts.slice(1).join('<shortcut>')

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      // Prevent Radix from highlighting the inline rebind link on open.
      onOpenAutoFocus={(event) => event.preventDefault()}
      visual={<CmdJPaletteFeatureTipVisual />}
    >
      <DialogHeader className="gap-4 text-left">
        <div>
          {/* Category label. */}
          <FeatureTipEyebrow label={tip.eyebrow} />
          {/* Keep the shortcut inline so wide Windows/Linux bindings wrap naturally. */}
          <DialogTitle className="text-2xl font-semibold leading-tight tracking-tight md:text-[1.75rem]">
            {titlePrefix.trimEnd()}
            {displayShortcutLabel ? (
              <>
                {' '}
                <kbd className="ml-0.5 inline-flex items-center whitespace-nowrap rounded-md border border-border bg-card px-2 py-0.5 align-middle font-mono text-base font-medium text-foreground">
                  {displayShortcutLabel}
                </kbd>
              </>
            ) : null}
            {titleSuffix ? ` ${titleSuffix}` : null}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed">
            <span className="block">{tip.description}</span>
            <FeatureTipSettingsLine
              lead={translate(
                'auto.components.feature.tips.CmdJPaletteTipDialog.8241897205',
                'Rebind the shortcut anytime in'
              )}
              link={translate(
                'auto.components.feature.tips.CmdJPaletteTipDialog.c0bb9f869b',
                'Settings → Shortcuts'
              )}
              onClick={onRebindClick}
            />
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
    </FeatureTipDialogFrame>
  )
}

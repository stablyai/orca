import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { FeatureTipActions } from './FeatureTipActions'
import { VoiceDictationFeatureTipVisual } from './VoiceDictationFeatureTipVisual'

export function VoiceDictationTipDialog({
  open,
  tip,
  primaryBusy,
  onOpenChange,
  onPrimaryAction,
  onSkip,
  onVoiceSettingsClick
}: {
  open: boolean
  tip: FeatureTip
  primaryBusy: boolean
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSkip: () => void
  onVoiceSettingsClick: () => void
}): JSX.Element {
  const shortcut = useShortcutKeyDetails('voice.dictation')
  const primaryButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background))] p-0 dark:bg-[color-mix(in_srgb,var(--foreground)_16%,var(--background))] sm:max-w-4xl md:!h-[min(27rem,calc(100vh-2rem))] md:!flex-row"
        showCloseButton
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          primaryButtonRef.current?.focus()
        }}
      >
        <div className="scrollbar-sleek flex min-h-0 min-w-0 flex-1 flex-col justify-between overflow-y-auto px-8 py-9 md:shrink-0 md:basis-1/2">
          <DialogHeader className="gap-4 text-left">
            <div>
              <Badge
                variant="outline"
                className="mb-3 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
              >
                {tip.eyebrow.toUpperCase()}
              </Badge>
              <DialogTitle className="text-2xl font-semibold leading-tight tracking-tight md:text-[1.75rem]">
                {tip.title}
              </DialogTitle>
              <DialogDescription className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed">
                {shortcut.keys.length > 0 ? (
                  <span className="block">
                    {translate(
                      'featureTips.voice.focusPaneInstruction',
                      'Focus a terminal, editor, or agent prompt, then press'
                    )}{' '}
                    <ShortcutKeyCombo
                      keys={shortcut.keys}
                      doubleTap={shortcut.doubleTap}
                      className="mx-1 align-middle"
                      keyCapClassName="min-w-0 bg-card px-1.5 py-0 text-[11px] text-foreground shadow-none"
                    />{' '}
                    {translate(
                      'featureTips.voice.startInstruction',
                      'to start voice dictation. Press'
                    )}{' '}
                    <ShortcutKeyCombo
                      keys={shortcut.keys}
                      doubleTap={shortcut.doubleTap}
                      className="mx-1 align-middle"
                      keyCapClassName="min-w-0 bg-card px-1.5 py-0 text-[11px] text-foreground shadow-none"
                    />{' '}
                    {translate('featureTips.voice.stopInstruction', 'again to stop.')}
                  </span>
                ) : (
                  <span className="block">
                    {translate(
                      'featureTips.voice.unassignedInstruction',
                      'Assign a dictation shortcut before starting voice dictation in a focused pane.'
                    )}
                  </span>
                )}
                <span className="block text-muted-foreground">
                  {translate(
                    'featureTips.voice.settingsInstruction',
                    'Change the model, dictation mode, or shortcut anytime in'
                  )}{' '}
                  <button
                    type="button"
                    onClick={onVoiceSettingsClick}
                    className="inline appearance-none border-0 bg-transparent p-0 font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:decoration-foreground"
                  >
                    {translate('featureTips.voice.settingsLink', 'Settings → Voice')}
                  </button>
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
              primaryButtonRef={primaryButtonRef}
            />
          </DialogFooter>
        </div>

        <div className="flex min-h-0 min-w-0 shrink-0 self-stretch overflow-hidden bg-muted/60 md:basis-1/2 md:border-l md:border-border/70">
          <div className="h-full min-h-[23rem] w-full md:w-[29.4rem]">
            <VoiceDictationFeatureTipVisual />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'
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
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        primaryButtonRef.current?.focus()
      }}
      visual={<VoiceDictationFeatureTipVisual />}
    >
      <DialogHeader className="gap-4 text-left">
        <div>
          <FeatureTipEyebrow label={tip.eyebrow} />
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
                {translate('featureTips.voice.startInstruction', 'to start voice dictation. Press')}{' '}
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
            <FeatureTipSettingsLine
              lead={translate(
                'featureTips.voice.settingsInstruction',
                'Change the model, dictation mode, or shortcut anytime in'
              )}
              link={translate('featureTips.voice.settingsLink', 'Settings → Voice')}
              onClick={onVoiceSettingsClick}
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
          primaryButtonRef={primaryButtonRef}
        />
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}

import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-education/feature-tips'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { ChatUiHereFeatureTipVisual } from './ChatUiHereFeatureTipVisual'
import { getChatUiHereVariantCopy, type ShownChatUiLaunchTipVariant } from './chat-ui-here-copy'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FEATURE_TIP_BUTTONS_ON_CARD_EDGE,
  FeatureTipDialogFrame,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'

export function ChatUiHereTipDialog({
  open,
  tip,
  variant,
  swapButtons = false,
  onOpenChange,
  onPrimaryAction,
  onSkip,
  onSettingsClick
}: {
  open: boolean
  tip: FeatureTip
  variant: ShownChatUiLaunchTipVariant
  swapButtons?: boolean
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSkip: () => void
  onSettingsClick: () => void
}): JSX.Element {
  const t = useTranslate()
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const { paragraphs, secondaryLabel, primaryLabel } = getChatUiHereVariantCopy(variant, t)

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: longer locales overflow the fixed frame; scrolling to the button would hide the title.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      visual={<ChatUiHereFeatureTipVisual />}
      copyClassName={FEATURE_TIP_BUTTONS_ON_CARD_EDGE}
    >
      <DialogHeader className="text-left">
        <div>
          <DialogTitle size="display">
            {t('featureTips.chatUiHere.title', 'Chat UI is here')}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-2xl">
            <span className="block space-y-3 leading-relaxed">
              {paragraphs.map((paragraph) => (
                <span key={paragraph} className="block">
                  {paragraph}
                </span>
              ))}
              <FeatureTipSettingsLine
                text={t(
                  'featureTips.chatUiHere.changeInSettings',
                  'Change anytime in <link>Settings → Chat UI</link>.'
                )}
                onClick={onSettingsClick}
              />
            </span>
          </DialogDescription>
        </div>
      </DialogHeader>

      <DialogFooter className="mt-8 flex sm:justify-end sm:[&>button]:w-auto sm:[&>button]:flex-none md:justify-stretch md:[&>button[data-variant=default]]:w-full md:[&>button[data-variant=default]]:flex-1">
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={false}
          swapButtons={swapButtons && variant === 'chat-ui-off'}
          onPrimaryAction={onPrimaryAction}
          onSkip={onSkip}
          showSkip={secondaryLabel !== null}
          secondaryLabel={secondaryLabel ?? undefined}
          fullWidth
          primaryButtonRef={primaryButtonRef}
          label={primaryLabel}
        />
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}

import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { ChatUiHereFeatureTipVisual } from './ChatUiHereFeatureTipVisual'
import { getChatUiHereVariantCopy, type ShownChatUiLaunchTipVariant } from './chat-ui-here-copy'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'

// Side by side, the outer edge of the primary button's 3px focus ring sits on the bottom of the
// visual's centered 22rem card; the column is the frame less its 1px borders.
const BUTTONS_ON_CARD_EDGE = 'md:pb-[calc((min(27rem,100vh-2rem)-2px-22rem)/2+3px)]'

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
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const { paragraphs, secondaryLabel, primaryLabel } = getChatUiHereVariantCopy(variant)

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
      copyClassName={BUTTONS_ON_CARD_EDGE}
    >
      <DialogHeader className="text-left">
        <div>
          <FeatureTipEyebrow label={translate('featureTips.eyebrowNew', 'New')} />
          <DialogTitle size="display">
            {translate('featureTips.chatUiHere.title', 'Chat UI is here')}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-2xl">
            <span className="block space-y-3 leading-relaxed">
              {paragraphs.map((paragraph) => (
                <span key={paragraph} className="block">
                  {paragraph}
                </span>
              ))}
              <FeatureTipSettingsLine
                text={translate(
                  'featureTips.chatUiHere.changeInSettings',
                  'Change anytime in <link>Settings → Agents</link>.'
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

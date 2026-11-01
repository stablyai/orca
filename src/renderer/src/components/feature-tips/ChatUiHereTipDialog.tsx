import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { ChatUiHereFeatureTipVisual } from './ChatUiHereFeatureTipVisual'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'

type ShownVariant = Exclude<ChatUiLaunchTipVariant, 'none'>

// Side by side, the outer edge of the primary button's 3px focus ring sits on the bottom of the
// visual's centered 22rem card; the column is the frame less its 1px borders.
const BUTTONS_ON_CARD_EDGE = 'md:pb-[calc((min(27rem,100vh-2rem)-2px-22rem)/2+3px)]'

function variantCopy(variant: ShownVariant): {
  paragraphs: string[]
  secondaryLabel: string | null
  primaryLabel: string
} {
  if (variant === 'chat-ui-off') {
    return {
      paragraphs: [
        translate(
          'featureTips.chatUiHere.offIntro',
          'Agents can now open as a chat, with rich messages, visuals and images.'
        ),
        translate(
          'featureTips.chatUiHere.offTerminal',
          'Prefer the terminal? It stays fully supported. Your agents keep opening there until you choose Chat.'
        )
      ],
      secondaryLabel: translate('featureTips.chatUiHere.stayInTerminal', 'Stay in terminal'),
      primaryLabel: translate('featureTips.chatUiHere.cta', 'Use Chat UI')
    }
  }
  return {
    paragraphs: [
      translate(
        'featureTips.chatUiHere.onIntro',
        'Chat UI is out of Experimental and now part of Orca. Your agents keep opening as chats, with rich messages, visuals and images.'
      ),
      translate(
        'featureTips.chatUiHere.onTerminal',
        'The terminal stays fully supported too. Switch any agent back anytime.'
      )
    ],
    secondaryLabel: null,
    primaryLabel: translate('featureTips.gotIt', 'Got it')
  }
}

export function ChatUiHereTipDialog({
  open,
  tip,
  variant,
  onOpenChange,
  onPrimaryAction,
  onSkip,
  onSettingsClick
}: {
  open: boolean
  tip: FeatureTip
  variant: ShownVariant
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSkip: () => void
  onSettingsClick: () => void
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const { paragraphs, secondaryLabel, primaryLabel } = variantCopy(variant)

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

      <DialogFooter className="mt-8 flex sm:justify-stretch">
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={false}
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

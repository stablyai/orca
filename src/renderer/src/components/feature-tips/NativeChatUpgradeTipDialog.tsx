import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { translate } from '@/i18n/i18n'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'
import { NativeChatUpgradeFeatureTipVisual } from './NativeChatUpgradeFeatureTipVisual'

export function NativeChatUpgradeTipDialog({
  open,
  tip,
  primaryBusy,
  onOpenChange,
  onPrimaryAction,
  onSettingsClick
}: {
  open: boolean
  tip: FeatureTip
  primaryBusy: boolean
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSettingsClick: () => void
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: opening must leave the badge and title in view, whatever the copy's height.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      visual={<NativeChatUpgradeFeatureTipVisual />}
    >
      {/* Why: from md the frame has a fixed height and only the copy scrolls, keeping the focused
          Got it button in view. Below md the copy keeps its full height and the frame's column
          scrolls as one panel, so a short window can't squeeze the copy to a sliver. */}
      <div className="flex flex-1 flex-col md:min-h-0">
        {/* Why: "always" shows the thumb whenever longer translations overflow, with no hover needed;
            the gutter puts it in the frame padding so it never covers text. */}
        <ScrollArea
          type="always"
          data-testid="native-chat-upgrade-tip-copy"
          className="-mr-4 flex flex-col md:min-h-0 md:flex-1"
          viewportClassName="md:min-h-0 md:flex-1"
        >
          <DialogHeader className="text-left">
            <div className="pr-4">
              <FeatureTipEyebrow
                label={translate('featureTips.nativeChatUpgrade.eyebrow', tip.eyebrow)}
              />
              <DialogTitle variant="feature-tip">
                {translate('featureTips.nativeChatUpgrade.title', tip.title)}
              </DialogTitle>
              <DialogDescription variant="feature-tip" className="mt-3 max-w-2xl">
                <span className="block">
                  {translate('featureTips.nativeChatUpgrade.description', tip.description)}
                </span>
                <span className="mt-2 block">
                  {translate(
                    'featureTips.nativeChatUpgrade.sessionHistoryIntro',
                    'In Agent Session History, in the right sidebar:'
                  )}
                </span>
                <span className="mt-2 block">
                  <span className="font-medium text-foreground">
                    {translate(
                      'featureTips.nativeChatUpgrade.resumeInChatLabel',
                      'Resume in New Native Chat'
                    )}
                  </span>{' '}
                  {translate(
                    'featureTips.nativeChatUpgrade.resumeInChatText',
                    'moves a CLI session into a chat.'
                  )}
                </span>
                <span className="mt-2 block">
                  <span className="font-medium text-foreground">
                    {translate(
                      'featureTips.nativeChatUpgrade.resumeInCliLabel',
                      'Resume in New CLI'
                    )}
                  </span>{' '}
                  {translate(
                    'featureTips.nativeChatUpgrade.resumeInCliText',
                    'copies a Claude or Codex chat into a new CLI session. The chat stays as it is.'
                  )}
                </span>
                <span className="mt-2 block">
                  <FeatureTipSettingsLine
                    lead={translate(
                      'featureTips.nativeChatUpgrade.settingsLead',
                      'Change it anytime in'
                    )}
                    link={translate(
                      'featureTips.nativeChatUpgrade.settingsLink',
                      'Settings → Chat'
                    )}
                    onClick={onSettingsClick}
                  />
                </span>
              </DialogDescription>
            </div>
          </DialogHeader>
        </ScrollArea>

        <DialogFooter className="mt-4 flex shrink-0 sm:justify-stretch">
          <FeatureTipActions
            currentTip={tip}
            primaryBusy={primaryBusy}
            onPrimaryAction={onPrimaryAction}
            onSkip={() => onOpenChange(false)}
            showSkip={false}
            fullWidth
            primaryButtonRef={primaryButtonRef}
            label={translate('featureTips.nativeChatUpgrade.cta', tip.ctaLabel)}
          />
        </DialogFooter>
      </div>
    </FeatureTipDialogFrame>
  )
}

import { useId, useRef, type JSX } from 'react'
import { MessagesSquare, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import type { NativeChatUpgradeTipVariant } from '../../../../shared/native-chat-upgrade-tip-audience'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'
import { NativeChatUpgradeFeatureTipVisual } from './NativeChatUpgradeFeatureTipVisual'

// Interpolated in place of a {{name}} so the translated sentence keeps its own word order.
const EMPHASIS_SLOT = '\u0001'

/** A translated sentence with one bolded name in it. */
function EmphasisSentence({
  sentence,
  emphasis
}: {
  sentence: string
  emphasis: string
}): JSX.Element {
  const [before, ...after] = sentence.split(EMPHASIS_SLOT)
  return (
    <>
      {before}
      <span className="font-medium text-foreground">{emphasis}</span>
      {after.join('')}
    </>
  )
}

function ActionLine({
  icon: Icon,
  sentence,
  action
}: {
  icon: LucideIcon
  sentence: string
  action: string
}): JSX.Element {
  return (
    <span className="grid grid-cols-[0.875rem_minmax(0,1fr)] gap-x-2.5">
      <Icon className="mt-1 size-3.5 text-muted-foreground" aria-hidden />
      <span>
        <EmphasisSentence sentence={sentence} emphasis={action} />
      </span>
    </span>
  )
}

/** For users whose new agent tabs still open in the terminal: say so and offer the switch. */
function ChatModeSwitch({
  chatModeOn,
  onChatModeChange
}: {
  chatModeOn: boolean
  onChatModeChange: (on: boolean) => void
}): JSX.Element {
  const switchId = useId()
  return (
    <div className="mt-3 space-y-2 text-sm leading-relaxed">
      <p className="text-muted-foreground">
        {translate(
          'featureTips.nativeChatUpgrade.chatModeNote',
          'New agent tabs still open in the terminal, as before.'
        )}
      </p>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={switchId}>
            {translate('featureTips.nativeChatUpgrade.chatModeLabel', 'Turn on chat mode')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'featureTips.nativeChatUpgrade.chatModeHint',
              'New agent tabs open as chat instead.'
            )}
          </p>
        </div>
        <Switch id={switchId} checked={chatModeOn} onCheckedChange={onChatModeChange} />
      </div>
    </div>
  )
}

export function NativeChatUpgradeTipDialog({
  open,
  tip,
  primaryBusy,
  variant,
  chatModeOn,
  onOpenChange,
  onPrimaryAction,
  onChatModeChange,
  onSettingsClick
}: {
  open: boolean
  tip: FeatureTip
  primaryBusy: boolean
  /** From the saved tip audience, never the live setting. */
  variant: NativeChatUpgradeTipVariant
  /** Live Chat UI setting. */
  chatModeOn: boolean
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onChatModeChange: (on: boolean) => void
  onSettingsClick: () => void
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  // Why: only profiles whose new agent tabs opened in the terminal before the upgrade.
  const offerChatMode = variant === 'keep-terminal'

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: longer locales overflow the fixed frame; scrolling to the button would hide the title.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      visual={<NativeChatUpgradeFeatureTipVisual />}
      tall={offerChatMode}
    >
      <DialogHeader className="text-left">
        <div>
          <FeatureTipEyebrow label={translate('featureTips.nativeChatUpgrade.eyebrow', 'New')} />
          <DialogTitle size="display">
            {translate('featureTips.nativeChatUpgrade.title', 'Native chat got an upgrade')}
          </DialogTitle>
          {offerChatMode ? (
            <ChatModeSwitch chatModeOn={chatModeOn} onChatModeChange={onChatModeChange} />
          ) : null}
          <DialogDescription className="mt-3 max-w-2xl">
            <span className="block space-y-3 leading-relaxed">
              <span className="block">
                <EmphasisSentence
                  sentence={translate(
                    'featureTips.nativeChatUpgrade.intro',
                    'New chats with supported agents now open in the upgraded chat view. To move between chat and CLI, open {{panel}} in the right sidebar:',
                    { panel: EMPHASIS_SLOT }
                  )}
                  emphasis={translate(
                    'auto.components.right.sidebar.AiVaultPanel.sessionHistory',
                    'Agent Session History'
                  )}
                />
              </span>
              <span className="!mt-2 block space-y-1.5">
                <ActionLine
                  icon={MessagesSquare}
                  sentence={translate(
                    'featureTips.nativeChatUpgrade.resumeInNativeChat',
                    '{{action}} opens a supported CLI conversation in native chat.',
                    { action: EMPHASIS_SLOT }
                  )}
                  action={translate(
                    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
                    'Resume in New Native Chat'
                  )}
                />
                <ActionLine
                  icon={SquareTerminal}
                  sentence={translate(
                    'featureTips.nativeChatUpgrade.resumeInCli',
                    '{{action}} copies a Claude or Codex chat into a new CLI session. The original chat stays as it is.',
                    { action: EMPHASIS_SLOT }
                  )}
                  action={translate(
                    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCli',
                    'Resume in New CLI'
                  )}
                />
              </span>
              <FeatureTipSettingsLine
                lead={translate(
                  'featureTips.nativeChatUpgrade.settingsInstruction',
                  'Manage Chat UI in'
                )}
                link={translate(
                  'featureTips.nativeChatUpgrade.settingsLink',
                  'Settings → Experimental'
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
          primaryBusy={primaryBusy}
          onPrimaryAction={onPrimaryAction}
          onSkip={() => onOpenChange(false)}
          showSkip={false}
          fullWidth
          primaryButtonRef={primaryButtonRef}
          label={translate('featureTips.nativeChatUpgrade.gotIt', 'Got it')}
        />
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}

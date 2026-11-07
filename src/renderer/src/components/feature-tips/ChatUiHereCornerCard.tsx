import { useEffect, useRef, useState, type JSX, type MouseEvent } from 'react'
import { X } from 'lucide-react'
import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { ChatSurfacePreview } from '../agent/launch-settings/AgentDefaultSurfacePreviews'
import { getChatUiHereVariantCopy } from './chat-ui-here-copy'
import { FeatureTipActions } from './FeatureTipActions'
import { FeatureTipSettingsLine } from './FeatureTipDialogFrame'
import { ChatUiSwitchedCornerNote } from './ChatUiSwitchedCornerNote'
import { trackChatUiFeatureTipAction } from './feature-tip-telemetry'
import {
  setAgentDefaultSurfaceFromFeatureTip,
  openChatUiFeatureTipSettings
} from './chat-ui-here-actions'

type CornerCardState =
  | { stage: 'prompt' | 'saving' }
  | { stage: 'switched'; focusSettings: boolean }

/** The nonblocking launch card for terminal-default profiles, sharing the tip's copy and a compact chat preview. */
export function ChatUiHereCornerCard({ onClose }: { onClose: () => void }): JSX.Element | null {
  const mountedRef = useMountedRef()
  const settings = useAppStore((s) => s.settings)
  const [state, setState] = useState<CornerCardState>({ stage: 'prompt' })
  const focusSwitchedNote = useRef(false)

  useEffect(() => {
    if (state.stage !== 'saving') {
      return
    }
    // Disabling the save button drops focus to body; cancel restoration if the user moves on.
    const cancelFocusTransfer = (): void => {
      focusSwitchedNote.current = false
    }
    document.addEventListener('focusin', cancelFocusTransfer)
    document.addEventListener('pointerdown', cancelFocusTransfer)
    return () => {
      document.removeEventListener('focusin', cancelFocusTransfer)
      document.removeEventListener('pointerdown', cancelFocusTransfer)
    }
  }, [state.stage])

  const tip = FEATURE_TIPS.find((entry) => entry.id === 'chat-ui-here')
  if (!tip) {
    return null
  }
  if (state.stage === 'switched') {
    return <ChatUiSwitchedCornerNote onClose={onClose} focusSettings={state.focusSettings} />
  }
  const { paragraphs, secondaryLabel, primaryLabel } = getChatUiHereVariantCopy('chat-ui-off')
  const [intro = ''] = paragraphs

  const handleUseChatUi = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    if (state.stage !== 'prompt') {
      return
    }
    focusSwitchedNote.current = event.detail === 0 && document.activeElement === event.currentTarget
    setState({ stage: 'saving' })
    const saved = await setAgentDefaultSurfaceFromFeatureTip('chat', { confirmWithToast: false })
    if (mountedRef.current) {
      setState(
        saved
          ? { stage: 'switched', focusSettings: focusSwitchedNote.current }
          : { stage: 'prompt' }
      )
    }
  }

  const handleStayInTerminal = (): void => {
    trackChatUiFeatureTipAction('chat-ui-off', 'stay_in_terminal')
    onClose()
  }

  const handleDismiss = (): void => {
    trackChatUiFeatureTipAction('chat-ui-off', 'dismissed')
    onClose()
  }

  const handleOpenSettings = (): void => {
    trackChatUiFeatureTipAction('chat-ui-off', 'open_settings')
    onClose()
    openChatUiFeatureTipSettings()
  }

  return (
    <Card
      role="complementary"
      aria-labelledby="chat-ui-here-corner-heading"
      className="overflow-hidden"
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle id="chat-ui-here-corner-heading">
            {translate('featureTips.chatUiHere.title', 'Chat UI is here')}
          </CardTitle>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleDismiss}
            aria-label={translate('featureTips.chatUiHere.dismiss', 'Dismiss')}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </CardHeader>

      <div
        aria-hidden="true"
        className="h-[17rem] border-y border-border bg-[color-mix(in_srgb,var(--foreground)_7%,var(--card))] p-3 dark:bg-[color-mix(in_srgb,var(--foreground)_14%,var(--card))]"
      >
        <ChatSurfacePreview />
      </div>

      <CardContent>
        <div className="space-y-3">
          <CardDescription>
            <span className="block space-y-2">
              <span className="block">{intro}</span>
              <FeatureTipSettingsLine
                text={translate(
                  'featureTips.chatUiHere.changeInSettings',
                  'Change anytime in <link>Settings → Chat UI</link>.'
                )}
                onClick={handleOpenSettings}
              />
            </span>
          </CardDescription>

          <div className="flex items-center gap-2">
            <FeatureTipActions
              currentTip={tip}
              primaryBusy={state.stage === 'saving'}
              swapButtons={
                settings?.telemetry?.chatUiLaunchTipButtonEmphasis === 'swapped' ||
                settings?.telemetry?.chatUiLaunchTipCohort === 'treatment-swapped-buttons'
              }
              onPrimaryAction={(event) => void handleUseChatUi(event)}
              onSkip={handleStayInTerminal}
              showSkip={secondaryLabel !== null}
              secondaryLabel={secondaryLabel ?? undefined}
              fullWidth
              label={primaryLabel}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

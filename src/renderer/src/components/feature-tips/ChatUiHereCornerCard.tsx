import { useState, type JSX } from 'react'
import { X } from 'lucide-react'
import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { ChatSurfacePreview } from '../settings/AgentDefaultSurfacePreviews'
import { getChatUiHereVariantCopy } from './chat-ui-here-copy'
import { FeatureTipActions } from './FeatureTipActions'
import { FeatureTipSettingsLine } from './FeatureTipDialogFrame'
import { trackChatUiFeatureTipAction } from './feature-tip-telemetry'
import { enableChatUiFromFeatureTip, openChatUiFeatureTipSettings } from './chat-ui-here-actions'

/** The nonblocking launch card for terminal-default profiles, sharing the tip's copy and a compact chat preview. */
export function ChatUiHereCornerCard({ onClose }: { onClose: () => void }): JSX.Element | null {
  const mountedRef = useMountedRef()
  const [busy, setBusy] = useState(false)

  const tip = FEATURE_TIPS.find((entry) => entry.id === 'chat-ui-here')
  if (!tip) {
    return null
  }
  const { paragraphs, secondaryLabel, primaryLabel } = getChatUiHereVariantCopy('chat-ui-off')
  const [intro = ''] = paragraphs

  const handleUseChatUi = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      if ((await enableChatUiFromFeatureTip()) && mountedRef.current) {
        onClose()
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
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
      className="gap-0 overflow-hidden py-0"
    >
      <CardHeader className="px-4 pt-3">
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
        className="mt-2 h-[17rem] border-y border-border bg-[color-mix(in_srgb,var(--foreground)_7%,var(--card))] p-3 dark:bg-[color-mix(in_srgb,var(--foreground)_14%,var(--card))]"
      >
        <ChatSurfacePreview />
      </div>

      <CardContent className="px-4 pt-4 pb-4">
        <div className="space-y-3">
          <CardDescription>
            <span className="block space-y-2">
              <span className="block">{intro}</span>
              <FeatureTipSettingsLine
                text={translate(
                  'featureTips.chatUiHere.changeInSettings',
                  'Change anytime in <link>Settings → Agents</link>.'
                )}
                onClick={handleOpenSettings}
              />
            </span>
          </CardDescription>

          <div className="flex items-center gap-2">
            <FeatureTipActions
              currentTip={tip}
              primaryBusy={busy}
              onPrimaryAction={() => void handleUseChatUi()}
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

import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeftRight, X } from 'lucide-react'
import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { ChatSurfacePreview } from '../settings/AgentDefaultSurfacePreviews'
import { getChatUiHereVariantCopy } from './chat-ui-here-copy'
import { FeatureTipActions } from './FeatureTipActions'
import { FeatureTipSettingsLine } from './FeatureTipDialogFrame'
import { LiveSwitchingDemoDialog } from './LiveSwitchingDemoDialog'
import { trackChatUiFeatureTipAction } from './feature-tip-telemetry'
import {
  setAgentDefaultSurfaceFromFeatureTip,
  openChatUiFeatureTipSettings
} from './chat-ui-here-actions'

/** The nonblocking launch card for terminal-default profiles, sharing the tip's copy and a compact chat preview. */
export function ChatUiHereCornerCard({ onClose }: { onClose: () => void }): JSX.Element | null {
  const mountedRef = useMountedRef()
  const settings = useAppStore((s) => s.settings)
  const [busy, setBusy] = useState(false)
  const [liveSwitchingOpen, setLiveSwitchingOpen] = useState(false)
  const liveSwitchingButtonRef = useRef<HTMLButtonElement>(null)

  const liveSwitching = settings?.telemetry?.chatUiLaunchTipCohort === 'treatment-live-switch'
  const liveSwitchingShownRef = useRef(false)

  useEffect(() => {
    const button = liveSwitchingButtonRef.current
    if (!liveSwitching || liveSwitchingShownRef.current || !button) {
      return
    }
    const doc = button.ownerDocument
    let inView = false
    let active = true
    const recordExposure = (): void => {
      if (!active || !inView || doc.visibilityState !== 'visible') {
        return
      }
      liveSwitchingShownRef.current = true
      cleanup()
      trackChatUiFeatureTipAction('chat-ui-off', 'live_switching_shown')
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry?.isIntersecting === true && entry.intersectionRatio >= 0.5
        recordExposure()
      },
      { threshold: 0.5 }
    )
    const cleanup = (): void => {
      active = false
      observer.disconnect()
      doc.removeEventListener('visibilitychange', recordExposure)
    }
    doc.addEventListener('visibilitychange', recordExposure)
    observer.observe(button)
    return cleanup
  }, [liveSwitching])

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
      if ((await setAgentDefaultSurfaceFromFeatureTip('chat')) && mountedRef.current) {
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

  const handleOpenLiveSwitching = (): void => {
    trackChatUiFeatureTipAction('chat-ui-off', 'open_live_switching')
    setLiveSwitchingOpen(true)
  }

  return (
    <>
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
                {liveSwitching ? (
                  <button
                    ref={liveSwitchingButtonRef}
                    type="button"
                    aria-haspopup="dialog"
                    onClick={handleOpenLiveSwitching}
                    className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <ArrowLeftRight className="size-3.5" />
                    {translate('featureTips.chatUiHere.liveSwitching', 'Live switching available')}
                  </button>
                ) : null}
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
                swapButtons={
                  settings?.telemetry?.chatUiLaunchTipButtonEmphasis === 'swapped' ||
                  settings?.telemetry?.chatUiLaunchTipCohort === 'treatment-swapped-buttons'
                }
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

      {liveSwitching ? (
        <LiveSwitchingDemoDialog
          open={liveSwitchingOpen}
          onOpenChange={setLiveSwitchingOpen}
          onCloseAutoFocus={(event) => {
            if (liveSwitchingButtonRef.current?.isConnected) {
              event.preventDefault()
              liveSwitchingButtonRef.current.focus()
            }
          }}
        />
      ) : null}
    </>
  )
}

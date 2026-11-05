import { useEffect, useEffectEvent, useState, type JSX } from 'react'
import { Trans } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { i18n, translate } from '@/i18n/i18n'
import { openChatUiSettingsSearch } from './chat-ui-here-actions'

const AUTO_DISMISS_MS = 12_000

/** Replaces the launch card after Use Chat UI so the way back shows where the user clicked. */
export function ChatUiSwitchedCornerNote({ onClose }: { onClose: () => void }): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const dismiss = useEffectEvent(onClose)

  useEffect(() => {
    if (paused) {
      return
    }
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [paused])

  const handleOpenSettings = (): void => {
    onClose()
    openChatUiSettingsSearch()
  }

  return (
    <Card
      role="status"
      aria-live="polite"
      aria-labelledby="chat-ui-switched-note-heading"
      size="sm"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false)
        }
      }}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex size-[18px] items-center justify-center rounded-full bg-status-success-background text-status-success">
              <Check className="size-3" strokeWidth={3} />
            </span>
            <CardTitle id="chat-ui-switched-note-heading">
              {translate('featureTips.chatUiHere.switchedNoteTitle', "You're on Chat UI")}
            </CardTitle>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label={translate('featureTips.chatUiHere.dismiss', 'Dismiss')}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <CardDescription>
            <Trans
              i18n={i18n}
              defaults={translate(
                'featureTips.chatUiHere.switchedNoteBody',
                'Prefer the terminal? Switch back anytime: search <term>Chat UI</term> in Settings.'
              )}
              components={{ term: <span className="font-medium text-foreground" /> }}
            />
          </CardDescription>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {translate('featureTips.gotIt', 'Got it')}
            </Button>
            <Button variant="outline" size="sm" className="flex-1" onClick={handleOpenSettings}>
              {translate('featureTips.chatUiHere.openSettings', 'Open Settings')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

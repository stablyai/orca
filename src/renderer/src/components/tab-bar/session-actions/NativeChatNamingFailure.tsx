import { useRef } from 'react'
import { AlertCircle, RefreshCw, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { AgentCommandFailedDialog } from '@/components/agent-command-failure/AgentCommandFailedDialog'
import {
  chatNamingSettingsTarget,
  canOpenNamingSettings,
  isTransientNamingFailure,
  openNamingSettings
} from '@/components/agent-command-failure/naming-settings-link'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { NativeChatNamingFailureControls } from './use-native-chat-naming-failure'

function regenerateLabel(
  naming: NativeChatNamingFailureControls,
  t: Translate = translate
): string {
  return naming.regenerating
    ? t('tabHoverCard.namingFailure.regenerating', 'Regenerating…')
    : t('tabHoverCard.namingFailure.regenerate', 'Regenerate name')
}

export function NativeChatNamingErrorBlock({
  naming,
  onDismiss
}: {
  naming: NativeChatNamingFailureControls
  onDismiss?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-1 border-t border-border pt-2" data-tab-hover-card-naming-error>
      <div className="flex items-start gap-1.5 font-medium text-destructive">
        <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span>{t('tabHoverCard.namingFailure.title', "Couldn't name this chat")}</span>
      </div>
      <p className="pl-4.5 text-muted-foreground">
        {t(
          'tabHoverCard.namingFailure.description',
          'The chat-name agent stopped with an error, so the chat keeps its first message as its name.'
        )}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 pt-1 pl-4.5">
        <Button
          type="button"
          variant="destructive-chip"
          size="chip"
          onClick={() => naming.setDialogOpen(true)}
        >
          <AlertCircle />
          {t('tabHoverCard.namingFailure.viewError', 'view error')}
        </Button>
        {naming.canRegenerate ? (
          <Button
            type="button"
            variant="outline"
            size="chip"
            disabled={naming.regenerating}
            onClick={naming.regenerate}
          >
            <RefreshCw />
            {regenerateLabel(naming, t)}
          </Button>
        ) : null}
        {isWebClientLocation() || isTransientNamingFailure(naming.message) ? null : (
          <Button
            type="button"
            variant="ghost"
            size="chip"
            onClick={() => {
              onDismiss?.()
              openNamingSettings(chatNamingSettingsTarget(useAppStore.getState().settings))
            }}
          >
            <Settings aria-hidden />
            {t('tabHoverCard.namingFailure.settings', 'Settings')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function NativeChatNamingFailedDialog({
  naming,
  chatName
}: {
  naming: NativeChatNamingFailureControls
  chatName: string
}): React.JSX.Element {
  const t = useTranslate()
  const showOpenSettings =
    canOpenNamingSettings(naming.executionHostId) && !isTransientNamingFailure(naming.message)
  // Settings takes focus after the hand-off; the closing dialog must not pull it back to the tab.
  const settingsHandoffRef = useRef(false)
  return (
    <AgentCommandFailedDialog
      open={naming.dialogOpen}
      onOpenChange={naming.setDialogOpen}
      title={t('tabHoverCard.namingFailure.dialogTitle', 'Chat auto-name failed')}
      description={
        <>
          {t(
            'tabHoverCard.namingFailure.dialogDescriptionStart',
            "Orca couldn't generate a name for"
          )}{' '}
          <span className="font-medium text-foreground">{chatName}</span>{' '}
          {t('tabHoverCard.namingFailure.dialogDescriptionEnd', 'from its first message.')}
        </>
      }
      error={naming.message}
      readFullOutput={naming.readFullOutput}
      onCloseAutoFocus={(event) => {
        if (settingsHandoffRef.current) {
          settingsHandoffRef.current = false
          event.preventDefault()
        }
      }}
      action={
        <>
          {showOpenSettings ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                settingsHandoffRef.current = true
                naming.setDialogOpen(false)
                openNamingSettings(chatNamingSettingsTarget(useAppStore.getState().settings))
              }}
            >
              {t('components.native-chat.install.openAgentSettings', 'Open Settings')}
            </Button>
          ) : null}
          {naming.canRegenerate ? (
            <Button
              type="button"
              size="sm"
              disabled={naming.regenerating}
              onClick={() => {
                naming.regenerate()
                naming.setDialogOpen(false)
              }}
            >
              {regenerateLabel(naming, t)}
            </Button>
          ) : null}
        </>
      }
    />
  )
}

import { MessageSquare } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'

const loadCommanderChat = () => import('./open-commander-chat')

export function CommanderChatAction(): React.JSX.Element {
  const t = useTranslate()
  const disabled = useAppStore((state) => state.settings?.botsEnabled === false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')

  async function open(): Promise<void> {
    setOpening(true)
    setError('')
    try {
      const { openCommanderChat } = await loadCommanderChat()
      if (!(await openCommanderChat())) {
        setError(
          t('commander.chatUnavailable', 'The Commander workspace could not be opened. Try again.')
        )
      }
    } catch (reason) {
      setError(
        reason instanceof RuntimeRpcCallError && reason.code === 'method_not_found'
          ? t('commander.chatUpdate', 'Update Orca on this host to open Commander chat.')
          : reason instanceof Error && reason.message
            ? reason.message
            : t(
                'commander.chatUnavailable',
                'The Commander workspace could not be opened. Try again.'
              )
      )
    }
    setOpening(false)
  }

  function openBotSettings(): void {
    const state = useAppStore.getState()
    state.openSettingsTarget({ pane: 'bots', repoId: null })
    state.openSettingsPage()
  }

  return (
    <>
      <div className="inline-flex max-w-full flex-wrap items-center gap-2">
        {disabled && (
          <Button variant="link" size="sm" onClick={openBotSettings}>
            {t('commander.chatEnable', 'Enable bots in Settings')}
          </Button>
        )}
        <Button
          size="sm"
          disabled={disabled || opening}
          aria-busy={opening}
          onClick={() => void open()}
        >
          <MessageSquare aria-hidden="true" />
          {opening
            ? t('commander.chatOpening', 'Opening chat…')
            : t('commander.chatTalk', 'Talk to Commander')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="basis-full break-words text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

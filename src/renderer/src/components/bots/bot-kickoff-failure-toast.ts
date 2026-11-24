import { toast } from 'sonner'
import type { Bot } from '../../../../shared/bot-types'
import { botTarget } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

export function showBotKickoffFailure(bot: Bot, t: (key: string, value: string) => string): void {
  toast.error(t('bots.firstScreen.failed', 'Couldn’t finish setting up'), {
    action: {
      label: t('bots.firstScreen.tryAgain', 'Try again'),
      onClick: () =>
        void callRuntimeRpc(botTarget(bot), 'bots.kickoff.retry', { botId: bot.id }).catch(() =>
          toast.error(t('bots.firstScreen.retryFailed', 'Could not try again. Try in a moment.'))
        )
    }
  })
}

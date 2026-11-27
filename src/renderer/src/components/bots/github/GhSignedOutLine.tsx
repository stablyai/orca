// The one line a GitHub surface adds while gh is signed out on the computer the bot runs on.
import React from 'react'
import { CopyTextButton } from '@/components/clipboard/CopyTextButton'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { BotGitHubView } from '@/lib/bot-github-state'
import { ghSignedOut } from '../../../../../shared/connector-bot-github-contract'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { useBotComputerLabel } from '../use-bot-host-label'
import { BotHowToAsk, HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'

const GH_AUTH_LOGIN = 'gh auth login'

/** The computer gh is signed out on (its name, or this computer), or null while gh is signed in. */
export function useGhSignedOutHost(hostId: ExecutionHostId, view: BotGitHubView): string | null {
  const t = useTranslate()
  const computer = useBotComputerLabel(hostId)
  return view.status === 'ready' && ghSignedOut(view.github)
    ? (computer ?? t('bots.github.ghSignedOut.thisComputer', 'this computer'))
    : null
}

export function ghSignedOutStatus(host: string): string {
  return translate('bots.github.ghSignedOut.status', 'gh signed out on {{host}}', { host })
}

export function GhSignedOutLine({ host }: { host: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-status-warning" aria-hidden />
      <span className="min-w-0">
        <BotHowToAsk
          text={t(
            'bots.github.ghSignedOut.line',
            'gh is signed out on {{host}}. Run <code>gh auth login</code> there.',
            { host, ...HOW_TO_ASK_ESCAPED }
          )}
        />
      </span>
      <CopyTextButton
        text={GH_AUTH_LOGIN}
        label={t('bots.github.ghSignedOut.copy', 'Copy {{text}}', { text: GH_AUTH_LOGIN })}
      />
    </div>
  )
}

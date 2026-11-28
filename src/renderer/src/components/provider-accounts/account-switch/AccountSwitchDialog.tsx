import { Suspense, useSyncExternalStore } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useTranslate } from '@/i18n/use-translate'
import {
  answerClaudeAccountSwitchPrompt,
  getClaudeAccountSwitchPrompt,
  subscribeClaudeAccountSwitchPrompt
} from '@/lib/provider-accounts/claude-account-switch-sessions'
import {
  answerAntigravityAccountSwitchPrompt,
  getAntigravityAccountSwitchPrompt,
  subscribeAntigravityAccountSwitchPrompt
} from '@/lib/provider-accounts/antigravity-account-switch-sessions'
import {
  antigravityAccountSwitchCopy,
  claudeAccountSwitchCopy,
  type AccountSwitchAgent
} from '@/lib/provider-accounts/account-switch-copy'

const AccountSwitchPromptDialog = lazy(() => import('./AccountSwitchPromptDialog'))

const PROMPTS = {
  claude: {
    get: getClaudeAccountSwitchPrompt,
    subscribe: subscribeClaudeAccountSwitchPrompt,
    answer: answerClaudeAccountSwitchPrompt,
    copy: claudeAccountSwitchCopy
  },
  antigravity: {
    get: getAntigravityAccountSwitchPrompt,
    subscribe: subscribeAntigravityAccountSwitchPrompt,
    answer: answerAntigravityAccountSwitchPrompt,
    copy: antigravityAccountSwitchCopy
  }
} satisfies Record<AccountSwitchAgent, unknown>

/** The question an account switch asks about the agent's terminals still on the old account. */
export default function AccountSwitchDialog({
  agent
}: {
  agent: AccountSwitchAgent
}): React.JSX.Element | null {
  const t = useTranslate()
  const source = PROMPTS[agent]
  const prompt = useSyncExternalStore(source.subscribe, source.get, source.get)
  // Reset selections and the preference checkbox for each new switch prompt.
  return prompt ? (
    <Suspense fallback={null}>
      <AccountSwitchPromptDialog
        key={prompt.id}
        prompt={prompt}
        copy={source.copy(t)}
        onAnswer={source.answer}
      />
    </Suspense>
  ) : null
}

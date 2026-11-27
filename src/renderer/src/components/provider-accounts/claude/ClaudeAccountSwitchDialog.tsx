import { Suspense, useSyncExternalStore } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import {
  getClaudeAccountSwitchPrompt,
  subscribeClaudeAccountSwitchPrompt
} from '@/lib/provider-accounts/claude-account-switch-sessions'

const ClaudeAccountSwitchPromptDialog = lazy(() => import('./ClaudeAccountSwitchPromptDialog'))

export default function ClaudeAccountSwitchDialog(): React.JSX.Element | null {
  const prompt = useSyncExternalStore(
    subscribeClaudeAccountSwitchPrompt,
    getClaudeAccountSwitchPrompt,
    getClaudeAccountSwitchPrompt
  )
  // Reset selections and the preference checkbox for each new switch prompt.
  return prompt ? (
    <Suspense fallback={null}>
      <ClaudeAccountSwitchPromptDialog key={prompt.id} prompt={prompt} />
    </Suspense>
  ) : null
}

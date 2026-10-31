import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import { useAppStore } from '../../store'
import type { accountSettings } from './ai-vault-account-test-fixture'

export function nativeClient(settings: ReturnType<typeof accountSettings>) {
  let claude: ClaudeRateLimitAccountsState = {
    accounts: settings.claudeManagedAccounts.map((account) => ({
      ...account,
      home: account.managedAuthPath
    })),
    activeAccountId: null
  }
  let codex: CodexRateLimitAccountsState = {
    accounts: settings.codexManagedAccounts,
    activeAccountId: null
  }
  const claudeList = vi.fn(async () => claude)
  const codexList = vi.fn(async () => codex)
  window.api.claudeAccounts = { ...window.api.claudeAccounts, list: claudeList }
  window.api.codexAccounts = { ...window.api.codexAccounts, list: codexList }
  return {
    claudeList,
    codexList,
    setClaude: (value: ClaudeRateLimitAccountsState) => {
      claude = value
    },
    setCodex: (value: CodexRateLimitAccountsState) => {
      codex = value
    }
  }
}
export async function changeSettings(
  update: (settings: ReturnType<typeof accountSettings>) => ReturnType<typeof accountSettings>
) {
  await act(async () => {
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Missing fixture settings')
    }
    useAppStore.setState({ settings: update(settings) })
  })
}

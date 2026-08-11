import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  CursorRateLimitAccountsState,
  GlobalSettings,
  MuseSparkRateLimitAccountsState
} from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

export type ProviderAccountSelection = {
  accountId: string | null
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

// Why: the server applies a selection before it awaits provider usage
// refreshes, and those refreshes can crawl behind broken auth. Give the call
// room to finish instead of reporting failure for an applied switch.
const REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS = 30_000

type Settings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export async function selectClaudeProviderAccount(
  settings: Settings,
  selection: ProviderAccountSelection
): Promise<ClaudeRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<ClaudeRateLimitAccountsState>(
      target,
      'accounts.selectClaude',
      { accountId: selection.accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.claudeAccounts.select(selection)
}

export async function selectCodexProviderAccount(
  settings: Settings,
  selection: ProviderAccountSelection
): Promise<CodexRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<CodexRateLimitAccountsState>(
      target,
      'accounts.selectCodex',
      { accountId: selection.accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.codexAccounts.select(selection)
}

export async function removeClaudeProviderAccount(
  settings: Settings,
  accountId: string
): Promise<ClaudeRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<ClaudeRateLimitAccountsState>(
      target,
      'accounts.removeClaude',
      { accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.claudeAccounts.remove({ accountId })
}

export async function removeCodexProviderAccount(
  settings: Settings,
  accountId: string
): Promise<CodexRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<CodexRateLimitAccountsState>(
      target,
      'accounts.removeCodex',
      { accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.codexAccounts.remove({ accountId })
}

export async function selectCursorProviderAccount(
  settings: Settings,
  selection: ProviderAccountSelection
): Promise<CursorRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<CursorRateLimitAccountsState>(
      target,
      'accounts.selectCursor',
      { accountId: selection.accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.cursorAccounts.select(selection)
}

export async function removeCursorProviderAccount(
  settings: Settings,
  accountId: string
): Promise<CursorRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<CursorRateLimitAccountsState>(
      target,
      'accounts.removeCursor',
      { accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.cursorAccounts.remove({ accountId })
}

export async function selectMuseSparkProviderAccount(
  settings: Settings,
  selection: ProviderAccountSelection
): Promise<MuseSparkRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<MuseSparkRateLimitAccountsState>(
      target,
      'accounts.selectMuseSpark',
      { accountId: selection.accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.museSparkAccounts.select(selection)
}

export async function removeMuseSparkProviderAccount(
  settings: Settings,
  accountId: string
): Promise<MuseSparkRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<MuseSparkRateLimitAccountsState>(
      target,
      'accounts.removeMuseSpark',
      { accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.museSparkAccounts.remove({ accountId })
}

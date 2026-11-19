import { parseWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import { historyTranscriptKey } from '../../../../../../shared/ai-vault/resume/history-transcript-identity'
import { createContext, useContext } from 'react'
import { translate } from '@/i18n/i18n'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import { isLegacyAgentSessionAccountHome } from '../../../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../../../shared/agent-accounts/managed-account-types'
import { getManagedAccountPrimaryLabel } from '../../../../../../shared/agent-accounts/managed-account-display-names'
import type { HistoryContinuation } from '../../../../../../shared/ai-vault/resume/history-resume-accounts'

export type HistoryAccountCatalog = {
  continuations?: HistoryContinuation[]
  failedProviders?: ('claude' | 'codex')[]
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  settings: {
    historyResumeAccountsSupported?: boolean
    claudeWorkspaceAccounts?: Record<string, string>
    codexWorkspaceAccounts?: Record<string, string>
  }
}
export type HistoryAccountCatalogs = Record<string, HistoryAccountCatalog>
export const HistoryAccountContext = createContext<{
  catalogs: HistoryAccountCatalogs
  workspaceId?: string
}>({ catalogs: {} })
export const useHistoryAccountContext = () => useContext(HistoryAccountContext)

export function historyAccountInfo(
  session: AiVaultSession,
  catalog: HistoryAccountCatalog | undefined,
  workspaceId?: string
) {
  if (
    !catalog ||
    (session.agent !== 'codex' && session.agent !== 'claude') ||
    catalog.failedProviders?.includes(session.agent)
  ) {
    return null
  }
  const provider = session.agent
  const roster = catalog[provider]
  const parts = session.filePath.replace(/\\/g, '/').split('/')
  const namespace = provider === 'codex' ? 'codex-accounts' : 'claude-profiles'
  const offset = parts.lastIndexOf(namespace)
  const managedId = offset !== -1 && parts[offset + 2] === 'home' ? parts[offset + 1] : undefined
  const home =
    session.accountHome && isLegacyAgentSessionAccountHome(session.accountHome)
      ? session.accountHome.path
      : provider === 'codex'
        ? session.codexHome
        : undefined
  const claudeSource =
    provider === 'claude' && home
      ? catalog.claude.accounts.find(
          (entry) =>
            !entry.runsOnSystemDefault &&
            entry.home &&
            normalizeRuntimePathForComparison(entry.home) ===
              normalizeRuntimePathForComparison(home)
        )
      : undefined
  const system =
    session.accountHome === null ||
    (provider === 'claude' &&
      home &&
      catalog.claude.systemDefaultHome &&
      normalizeRuntimePathForComparison(home) ===
        normalizeRuntimePathForComparison(catalog.claude.systemDefaultHome)) ||
    (provider === 'codex' && session.codexHome === null) ||
    parts.includes(provider === 'codex' ? '.codex' : '.claude')
  const sourceId =
    session.accountHome === null
      ? null
      : (claudeSource?.id ?? managedId ?? (system ? null : undefined))
  const source = roster.accounts.find((account) => account.id === sourceId)
  const recorded = catalog.continuations?.find(
    (entry) =>
      historyTranscriptKey(entry.provider, entry.filePath) ===
      historyTranscriptKey(provider, session.filePath)
  )
  const lastAccountId = recorded?.accountId
  const last = roster.accounts.find((entry) => entry.id === lastAccountId)
  const systemDefaultEmail =
    provider === 'codex' ? catalog.codex.systemDefault?.email : catalog.claude.systemDefaultEmail
  const systemDefaultLabel = translate('accounts.claude.systemDefault', 'System default')
  const lastAccountLabel =
    lastAccountId === null
      ? systemDefaultEmail
        ? `${systemDefaultEmail} · ${systemDefaultLabel}`
        : systemDefaultLabel
      : last
        ? last.displayName
          ? `${last.displayName} · ${last.email}`
          : last.email
        : lastAccountId !== undefined
          ? translate(
              'historyResume.lastUnavailable',
              'The account last used is unavailable. Choose another account or sign in again in Settings.'
            )
          : undefined
  return {
    lastAccountId,
    lastAccountLabel,
    sourceId,
    sourceLabel: source ? getManagedAccountPrimaryLabel(source) : undefined,
    supported:
      Boolean(workspaceId) &&
      catalog.settings.historyResumeAccountsSupported === true &&
      !parseWslUncPath(session.filePath)
  }
}

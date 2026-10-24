import type { Repo } from '../../../../shared/repo-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import type { ProjectClaudeAccountPreference } from '../../../../shared/claude/project-claude-account-preference'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { translate } from '@/i18n/i18n'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'

export const DEFAULT_VALUE = '__default__'
export const ASK_VALUE = '__ask__'

export type ClaudeAccountOption = {
  value: string
  label: string
  disabled?: boolean
}

export function claudeAccountLabel(account: ClaudeManagedAccountSummary): string {
  return account.organizationName ? `${account.email} · ${account.organizationName}` : account.email
}

export function buildClaudeAccountOptions(input: {
  accounts: ClaudeManagedAccountSummary[]
  saved?: ProjectClaudeAccountPreference
}): ClaudeAccountOption[] {
  const options: ClaudeAccountOption[] = [
    {
      value: DEFAULT_VALUE,
      label: translate('auto.components.settings.RepositoryClaudeAccountSection.default', 'Default')
    },
    {
      value: ASK_VALUE,
      label: translate(
        'auto.components.settings.RepositoryClaudeAccountSection.ask',
        'Ask every time'
      )
    },
    ...input.accounts.map((account) => ({
      value: account.id,
      label: claudeAccountLabel(account)
    }))
  ]

  const saved = input.saved
  if (
    saved?.mode === 'account' &&
    !input.accounts.some((account) => account.id === saved.accountId)
  ) {
    options.push({
      value: saved.accountId,
      label: translate(
        'auto.components.settings.RepositoryClaudeAccountSection.removedAccountOption',
        'Removed account (unavailable)'
      ),
      disabled: true
    })
  }

  return options
}

function targetsWsl(projectRuntime: ProjectExecutionRuntimeResolution | undefined): boolean {
  return projectRuntime?.status === 'repair-required'
    ? projectRuntime.repair.preferredRuntime.kind === 'wsl'
    : projectRuntime?.runtime.kind === 'wsl'
}

// Why: SSH repos spawn Claude on a remote host that never sees the local managed-account store,
// and pinned launches support host accounts only, so a WSL-runtime project cannot pin either.
export function claudeAccountPinningUnsupportedReason(
  repo: Repo,
  projectRuntime?: ProjectExecutionRuntimeResolution
): 'ssh' | 'wsl' | null {
  if (repo.connectionId) {
    return 'ssh'
  }
  return targetsWsl(projectRuntime) ? 'wsl' : null
}

/** Reads the project runtime the launch path resolves, so WSL projects match their spawns. */
export function claudeAccountPinningUnsupportedReasonInState(
  state: Parameters<typeof getLocalRepoProjectExecutionRuntimeContext>[0],
  repo: Repo
): 'ssh' | 'wsl' | null {
  return claudeAccountPinningUnsupportedReason(
    repo,
    getLocalRepoProjectExecutionRuntimeContext(state, repo.id)
  )
}

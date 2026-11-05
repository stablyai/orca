import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { repoMatchesHostIdentity } from '@/store/slices/repo-host-identity'
import {
  fetchProviderAccountsSnapshot,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { getCodexAccountDisplayLabel } from '@/lib/codex-account-display-label'
import { wslHostDistroForTarget } from '@/lib/wsl-host-account-owner'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { PROJECT_AGENT_ACCOUNT_PIN_RUNTIME_CAPABILITY } from '../../../../shared/account-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { Repo } from '../../../../shared/repo-types'

const FOLLOW_SELECTION = '__selection__'

type PinAgent = 'claude' | 'codex'
type AccountChoice = { id: string; label: string }
type HostAccounts = { choices: AccountChoice[]; activeId: string | null }

/** Where the project's sessions run: this machine, one of its WSL distros, or a remote Orca host. */
function projectAccountHost(
  repo: Repo
): { target: RuntimeClientTarget; wslDistro: string | null } | null {
  const hostId = getRepoExecutionHostId(repo)
  if (hostId === 'local') {
    return { target: { kind: 'local' }, wslDistro: parseWslUncPath(repo.path)?.distro ?? null }
  }
  // An `ssh:` host runs nothing itself; managed SSH machines are `runtime:` hosts.
  return hostId.startsWith('runtime:')
    ? {
        target: { kind: 'environment', environmentId: hostId.slice('runtime:'.length) },
        wslDistro: null
      }
    : null
}

/** The host's accounts that can run this project's sessions: its own runtime, or the same distro. */
function hostAccounts(
  agent: PinAgent,
  snapshot: ProviderAccountsSnapshot,
  wslDistro: string | null
): HostAccounts {
  const state = snapshot[agent]
  const listed =
    agent === 'claude'
      ? snapshot.claude.accounts.map((account) => ({
          account,
          runtime: account.managedAuthRuntime
        }))
      : snapshot.codex.accounts.map((account) => ({ account, runtime: account.managedHomeRuntime }))
  const accounts = listed
    .filter(({ account, runtime }) =>
      wslDistro ? runtime === 'wsl' && account.wslDistro === wslDistro : runtime !== 'wsl'
    )
    .map(({ account }) => account)
  const selection = state.activeAccountIdsByRuntime
  return {
    choices: accounts.map((account) => ({
      id: account.id,
      label: agent === 'codex' ? getCodexAccountDisplayLabel(account, accounts) : account.email
    })),
    activeId: wslDistro
      ? (selection?.wsl[wslDistro] ?? null)
      : (selection?.host ?? state.activeAccountId)
  }
}

/** The account a project's Claude or Codex sessions launch under, saved on the project. */
export function ProjectAccountRow({
  entry,
  disabled
}: {
  entry: AgentPickerEntry
  disabled?: boolean
}): React.JSX.Element | null {
  const agent: PinAgent | null =
    entry.agent === 'claude' || entry.agent === 'codex' ? entry.agent : null
  const repoId = entry.draftTarget?.repoId
  const repoHostId = entry.draftTarget?.executionHostId
  // The draft names its project's host; route by that owner, never by the focused host.
  const repo = useAppStore((s) =>
    repoId && repoHostId
      ? s.repos.find((candidate) => repoMatchesHostIdentity(candidate, repoId, repoHostId))
      : undefined
  )
  const updateRepo = useAppStore((s) => s.updateRepo)
  const host = repo ? projectAccountHost(repo) : null
  // A WSL host's orcad has no accounts; this desktop owns its distro's, as for a WSL pane.
  const wslHostDistro = useAppStore((s) =>
    host ? wslHostDistroForTarget(host.target, s.runtimeEnvironments) : null
  )
  const hasHost = host !== null
  const environmentId = host?.target.kind === 'environment' ? host.target.environmentId : null
  const wslDistro = wslHostDistro ?? host?.wslDistro ?? null
  const hostKey = JSON.stringify([hasHost, environmentId, wslDistro, wslHostDistro, agent])
  const [loaded, setLoaded] = useState<{ key: string; accounts: HostAccounts | null } | null>(null)
  useEffect(() => {
    if (!agent || !hasHost) {
      return
    }
    const key = JSON.stringify([hasHost, environmentId, wslDistro, wslHostDistro, agent])
    const target: RuntimeClientTarget =
      environmentId && !wslHostDistro ? { kind: 'environment', environmentId } : { kind: 'local' }
    let current = true
    void (async () => {
      // An older remote host strips the pin from repo.update, so it would look saved and do nothing.
      const supported =
        environmentId === null ||
        (await runtimeEnvironmentSupportsCapability(
          environmentId,
          PROJECT_AGENT_ACCOUNT_PIN_RUNTIME_CAPABILITY
        ).catch(() => false))
      const snapshot = supported ? await fetchProviderAccountsSnapshot(target) : null
      if (current) {
        const usable = snapshot && !snapshot.failedProviders?.includes(agent)
        setLoaded({ key, accounts: usable ? hostAccounts(agent, snapshot, wslDistro) : null })
      }
    })().catch(() => current && setLoaded({ key, accounts: null }))
    return () => {
      current = false
    }
  }, [agent, hasHost, environmentId, wslDistro, wslHostDistro])
  const accounts = loaded?.key === hostKey ? loaded.accounts : null
  if (!agent || !repo || !accounts || accounts.choices.length === 0) {
    return null
  }
  const pinnedId = agent === 'claude' ? repo.claudeAccountId : repo.codexAccountId
  const pinned = accounts.choices.find((choice) => choice.id === pinnedId)
  const active = accounts.choices.find((choice) => choice.id === accounts.activeId)
  const followLabel = active
    ? translate('agentPicker.projectAccountFollow', 'Active account ({{email}})', {
        email: active.label
      })
    : translate('agentPicker.projectAccountFollowDefault', 'Active account')
  const field = agent === 'claude' ? 'claudeAccountId' : 'codexAccountId'
  return (
    <div className="flex min-h-7 min-w-0 items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">
        {translate('agentPicker.projectAccount', 'Account')}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={translate(
              'agentPicker.projectAccountLabel',
              '{{agent}} account for this project',
              {
                agent: entry.label
              }
            )}
            className="min-w-0 max-w-full"
          >
            <span className="truncate text-xs">{pinned?.label ?? followLabel}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={8} className="w-72">
          <DropdownMenuRadioGroup
            value={pinned?.id ?? FOLLOW_SELECTION}
            onValueChange={(value) => {
              void updateRepo(
                repo.id,
                { [field]: value === FOLLOW_SELECTION ? null : value },
                { hostId: getRepoExecutionHostId(repo) }
              )
            }}
          >
            <DropdownMenuRadioItem value={FOLLOW_SELECTION}>{followLabel}</DropdownMenuRadioItem>
            {accounts.choices.map((choice) => (
              <DropdownMenuRadioItem key={choice.id} value={choice.id}>
                <span className="truncate">{choice.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
            {translate(
              'agentPicker.projectAccountHint',
              'Saved for this project. New sessions here use it, in a terminal or a chat.'
            )}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

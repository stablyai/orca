import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { UserRound } from 'lucide-react'
import { toast } from 'sonner'
import {
  notifyWorkspaceAccountSettingsChanged,
  subscribeWorkspaceAccountSettingsChanged
} from '@/runtime/provider-accounts/observations/workspace-account-settings-changes'
import {
  fetchProviderAccountsSnapshot,
  getProviderAccountsOwnerKey
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { WorkspaceAccountOptions } from './WorkspaceAccountOptions'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { useAppStore } from '@/store/index'
import { wslHostDistroForTarget } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  workspaceAccountKey,
  WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID
} from '../../../../../../shared/agent-accounts/workspace-account-binding'
import { buildCodexStatusSwitchGroups } from '@/components/status-bar/accounts/status-bar-codex-accounts'
import { buildClaudeStatusSwitchGroups } from '@/components/status-bar/accounts/status-bar-claude-accounts'
import { getCodexStatusRuntimeKey } from '@/components/status-bar/accounts/status-bar-runtime-targets'
import { parseWslUncPath } from '../../../../../../shared/file-access/wsl-paths'

type HostSettings = {
  settings: {
    codexWorkspaceAccounts?: Record<string, string>
    claudeWorkspaceAccounts?: Record<string, string>
  }
}
type Selection = {
  accounts: { id: string; label: string; hostDefault: boolean; disabled?: boolean }[]
  bindings: Record<string, string>
}

export function WorkspaceProviderAccountSubMenu({
  provider,
  worktree,
  disabled,
  asSection = false
}: {
  provider: 'codex' | 'claude'
  worktree: Worktree
  disabled: boolean
  asSection?: boolean
}) {
  const t = useTranslate()
  const name = provider === 'codex' ? 'Codex' : 'Claude'
  const bindingKey = provider === 'codex' ? 'codexWorkspaceAccounts' : 'claudeWorkspaceAccounts'
  const target = useWorktreeRuntimeTarget(worktree.id)
  const wslHost = useAppStore((state) =>
    target ? wslHostDistroForTarget(target, state.runtimeEnvironments) : null
  )
  const [selection, setSelection] = useState<Selection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savingOwner, setSavingOwner] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const localSettings = useAppStore((state) => (target?.kind === 'local' ? state.settings : null))
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const targetKind = target?.kind
  const ownerKey = `${targetKind ?? 'none'}:${environmentId ?? ''}:${worktree.id}:${provider}`
  const saving = savingOwner === ownerKey
  const ownerRef = useRef<string | null>(ownerKey)
  useLayoutEffect(() => {
    ownerRef.current = ownerKey
    return () => {
      ownerRef.current = null
    }
  }, [ownerKey])
  const key = workspaceAccountKey(worktree.id)
  const distro = useAppStore((state) => {
    const context =
      target?.kind === 'local'
        ? getLocalProjectExecutionRuntimeContext(state, worktree.id)
        : undefined
    if (context?.status === 'resolved' && context.runtime.kind === 'wsl') {
      return context.runtime.distro
    }
    if (context?.status === 'repair-required') {
      return context.repair.preferredRuntime.distro
    }
    return parseWslUncPath(worktree.path)?.distro
  })

  useEffect(() => {
    if (!targetKind) {
      return
    }
    const owner = environmentId
      ? { kind: 'environment' as const, environmentId }
      : { kind: 'local' as const }
    return subscribeWorkspaceAccountSettingsChanged((changed) => {
      if (getProviderAccountsOwnerKey(changed) === getProviderAccountsOwnerKey(owner)) {
        setRevision((value) => value + 1)
      }
    })
  }, [environmentId, targetKind])

  useEffect(() => {
    if (!targetKind || wslHost) {
      return
    }
    const owner = environmentId
      ? { kind: 'environment' as const, environmentId }
      : { kind: 'local' as const }
    let current = true
    setSelection(null)
    setError(null)
    void Promise.all([
      callRuntimeRpc<HostSettings>(owner, 'settings.get', undefined),
      fetchProviderAccountsSnapshot(owner)
    ]).then(
      ([settings, accounts]) => {
        if (!current) {
          return
        }
        if (accounts.failedProviders?.includes(provider)) {
          setError(
            t(
              'auto.components.settings.AccountsPane.loadAccountsFailed',
              'Could not load provider accounts.'
            )
          )
          return
        }
        if (!settings.settings[bindingKey]) {
          setError(
            t(
              'workspace.codexAccount.unsupported',
              'Update this host to choose an account per workspace.'
            )
          )
          return
        }
        const runtimeTarget = distro
          ? { runtime: 'wsl' as const, wslDistro: distro }
          : { runtime: 'host' as const, wslDistro: null }
        const groups =
          provider === 'codex'
            ? buildCodexStatusSwitchGroups(accounts.codex, runtimeTarget)
            : buildClaudeStatusSwitchGroups(accounts.claude, runtimeTarget)
        const group = groups.find((entry) => entry.key === getCodexStatusRuntimeKey(runtimeTarget))
        setSelection({
          accounts: (group?.targets ?? []).map((entry) => ({
            id: entry.id ?? WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID,
            label: [
              entry.label,
              entry.id === null
                ? 'detail' in entry
                  ? entry.detail?.replaceAll('\n', ' \u00b7 ')
                  : accounts.claude.systemDefaultEmail
                : null
            ]
              .filter(Boolean)
              .join(' \u00b7 '),
            hostDefault: entry.active,
            disabled: 'disabled' in entry ? entry.disabled : false
          })),
          bindings: settings.settings[bindingKey]
        })
      },
      (failure: unknown) => {
        if (current) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }
    )
    return () => {
      current = false
    }
  }, [environmentId, targetKind, wslHost, t, provider, bindingKey, localSettings, revision, distro])

  const save = async (value: string) => {
    if (!target || saving) {
      return
    }
    setSavingOwner(ownerKey)
    try {
      const result = await callRuntimeRpc<HostSettings>(target, 'settings.update', {
        [provider === 'codex' ? 'codexWorkspaceAccount' : 'claudeWorkspaceAccount']: {
          workspaceId: worktree.id,
          accountId: selection?.accounts.find((account) => account.id === value)?.hostDefault
            ? null
            : value
        }
      })
      if (ownerRef.current !== ownerKey) {
        return
      }
      setSelection((previous) =>
        previous ? { ...previous, bindings: result.settings[bindingKey] ?? {} } : previous
      )
      notifyWorkspaceAccountSettingsChanged(target)
      if (target.kind === 'local') {
        await useAppStore.getState().fetchSettings()
      }
      void callRuntimeRpc(target, 'accounts.list', { refreshUsage: true }).catch(
        (failure: unknown) => console.error('Failed to refresh workspace account usage:', failure)
      )
      toast.success(
        t(
          'workspace.account.savedForNewSessions',
          'New sessions will use {{account}}. Running sessions keep their account.',
          {
            account:
              selection?.accounts.find((account) => account.id === value)?.label ??
              t('workspace.codexAccount.inherit', 'Use host default')
          }
        )
      )
    } catch (failure) {
      if (ownerRef.current !== ownerKey) {
        return
      }
      toast.error(
        t('workspace.account.failed', 'Could not save the workspace {{provider}} account.', {
          provider: name
        }),
        {
          description: failure instanceof Error ? failure.message : String(failure)
        }
      )
    }
  }

  const accounts = selection?.accounts ?? []
  const selectedId = selection?.bindings[key] ?? accounts.find((account) => account.hostDefault)?.id

  const options = (
    <WorkspaceAccountOptions
      provider={name}
      accounts={accounts}
      selectedId={selectedId}
      loading={!selection && Boolean(target) && !wslHost}
      saving={saving || disabled || !target}
      error={
        wslHost
          ? t('workspace.codexAccount.wslHost', 'This WSL host uses the desktop account selection.')
          : !target
            ? t(
                'workspace.account.directSshUnavailable',
                'Account selection is unavailable on direct SSH hosts.'
              )
            : error
      }
      onSelect={(value) => {
        void save(value).finally(() => {
          setSavingOwner((current) => (current === ownerKey ? null : current))
        })
      }}
    />
  )
  if (asSection) {
    return (
      <>
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        {options}
      </>
    )
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled || !target}>
        <UserRound className="size-3.5" />
        {t('workspace.account.title', '{{provider}} account', { provider: name })}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent scrollable>
        <DropdownMenuLabel>
          {t('workspace.codexAccount.scope', 'For new sessions in this workspace')}
        </DropdownMenuLabel>
        {options}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { notifyWorkspaceAccountSettingsChanged } from '@/runtime/provider-accounts/observations/workspace-account-settings-changes'
import {
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { WorkspaceAccountOptions } from './WorkspaceAccountOptions'
import { getClaudeAccountLabel } from '@/lib/provider-accounts/claude-account-label'
import { getCodexAccountDisplayLabel } from '../../../../../../shared/agent-accounts/codex-account-display-label'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { useAppStore } from '@/store/index'
import { wslHostDistroForTarget } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type {
  CodexRateLimitAccountsState,
  ClaudeRateLimitAccountsState
} from '../../../../../../shared/agent-accounts/managed-account-types'
import { workspaceAccountKey } from '../../../../../../shared/agent-accounts/workspace-account-binding'
import { parseWslUncPath } from '../../../../../../shared/file-access/wsl-paths'

type HostSettings = {
  settings: {
    codexWorkspaceAccounts?: Record<string, string>
    claudeWorkspaceAccounts?: Record<string, string>
  }
}
type Selection = {
  accounts: { id: string; label: string; runtime?: string; wslDistro?: string | null }[]
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
  const [saving, setSaving] = useState(false)
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const targetKind = target?.kind
  const ownerKey = `${targetKind ?? 'none'}:${environmentId ?? ''}:${worktree.id}:${provider}`
  const ownerRef = useRef<string | null>(ownerKey)
  useLayoutEffect(() => {
    ownerRef.current = ownerKey
    return () => {
      ownerRef.current = null
    }
  }, [ownerKey])
  const key = workspaceAccountKey(worktree.id)

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
      callRuntimeRpc<{ codex: CodexRateLimitAccountsState; claude: ClaudeRateLimitAccountsState }>(
        owner,
        'accounts.list',
        {
          refreshUsage: false
        }
      )
    ]).then(
      ([settings, accounts]) => {
        if (!current) {
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
        setSelection({
          accounts:
            provider === 'codex'
              ? accounts.codex.accounts.map((account) => ({
                  id: account.id,
                  label: getCodexAccountDisplayLabel(account, accounts.codex.accounts),
                  runtime: account.managedHomeRuntime,
                  wslDistro: account.wslDistro
                }))
              : accounts.claude.accounts.map((account) => ({
                  id: account.id,
                  label: getClaudeAccountLabel(accounts.claude, account.id),
                  runtime: account.managedAuthRuntime,
                  wslDistro: account.wslDistro
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
  }, [environmentId, targetKind, wslHost, t, provider, bindingKey])

  const save = async (value: string) => {
    if (!target || saving) {
      return
    }
    setSaving(true)
    try {
      const result = await callRuntimeRpc<HostSettings>(target, 'settings.update', {
        [provider === 'codex' ? 'codexWorkspaceAccount' : 'claudeWorkspaceAccount']: {
          workspaceId: worktree.id,
          accountId: value === 'inherit' ? null : value
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
      toast.error(
        t('workspace.account.failed', 'Could not save the workspace {{provider}} account.', {
          provider: name
        }),
        {
          description: failure instanceof Error ? failure.message : String(failure)
        }
      )
    }
    setSaving(false)
  }

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
  const accounts =
    selection?.accounts.filter((account) =>
      distro
        ? account.runtime === 'wsl' && account.wslDistro?.toLowerCase() === distro.toLowerCase()
        : account.runtime !== 'wsl'
    ) ?? []
  const selectedId = selection?.bindings[key]

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
            ? 'Account selection is unavailable on direct SSH hosts.'
            : error
      }
      onSelect={(value) => void save(value)}
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

import { useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { WorkspaceCodexAccountOptions } from './WorkspaceCodexAccountOptions'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { useAppStore } from '@/store/index'
import { wslHostDistroForTarget } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { CodexRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import { codexWorkspaceAccountKey } from '../../../../../../shared/agent-accounts/codex/codex-workspace-account'
import { parseWslUncPath } from '../../../../../../shared/file-access/wsl-paths'

type HostSettings = { settings: { codexWorkspaceAccounts?: Record<string, string> } }
type Selection = { accounts: CodexRateLimitAccountsState; bindings: Record<string, string> }

export function WorkspaceCodexAccountSubMenu({
  worktree,
  disabled
}: {
  worktree: Worktree
  disabled: boolean
}) {
  const t = useTranslate()
  const target = useWorktreeRuntimeTarget(worktree.id)
  const wslHost = useAppStore((state) =>
    target ? wslHostDistroForTarget(target, state.runtimeEnvironments) : null
  )
  const [selection, setSelection] = useState<Selection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const targetKind = target?.kind
  const key = codexWorkspaceAccountKey(worktree.id)

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
      callRuntimeRpc<{ codex: CodexRateLimitAccountsState }>(owner, 'accounts.list', {
        refreshUsage: false
      })
    ]).then(
      ([settings, accounts]) => {
        if (!current) {
          return
        }
        if (!settings.settings.codexWorkspaceAccounts) {
          setError(
            t(
              'workspace.codexAccount.unsupported',
              'Update this host to choose an account per workspace.'
            )
          )
          return
        }
        setSelection({
          accounts: accounts.codex,
          bindings: settings.settings.codexWorkspaceAccounts
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
  }, [environmentId, targetKind, wslHost, t])

  const save = async (value: string) => {
    if (!target || saving) {
      return
    }
    setSaving(true)
    try {
      const result = await callRuntimeRpc<HostSettings>(target, 'settings.update', {
        codexWorkspaceAccount: {
          workspaceId: worktree.id,
          accountId: value === 'inherit' ? null : value
        }
      })
      setSelection((previous) =>
        previous
          ? { ...previous, bindings: result.settings.codexWorkspaceAccounts ?? {} }
          : previous
      )
      if (target.kind === 'local') {
        await useAppStore.getState().fetchSettings()
      }
      void callRuntimeRpc(target, 'accounts.list', { refreshUsage: true }).catch(
        (failure: unknown) => console.error('Failed to refresh workspace Codex usage:', failure)
      )
      toast.success(
        t('workspace.codexAccount.saved', 'Codex account saved for new sessions in this workspace.')
      )
    } catch (failure) {
      toast.error(
        t('workspace.codexAccount.failed', 'Could not save the workspace Codex account.'),
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
    selection?.accounts.accounts.filter((account) =>
      distro
        ? account.managedHomeRuntime === 'wsl' &&
          account.wslDistro?.toLowerCase() === distro.toLowerCase()
        : account.managedHomeRuntime !== 'wsl'
    ) ?? []
  const selectedId = selection?.bindings[key]

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled || !target}>
        <UserRound className="size-3.5" />
        {t('workspace.codexAccount.title', 'Codex account')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuLabel>
          {t('workspace.codexAccount.scope', 'For new sessions in this workspace')}
        </DropdownMenuLabel>
        <WorkspaceCodexAccountOptions
          accounts={accounts}
          selectedId={selectedId}
          loading={!selection}
          saving={saving}
          error={
            wslHost
              ? t(
                  'workspace.codexAccount.wslHost',
                  'This WSL host uses the desktop account selection.'
                )
              : error
          }
          onSelect={(value) => void save(value)}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

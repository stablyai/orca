import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { fetchProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import type { ProviderAccountRef } from '../../../../shared/provider-account-ref'
import { AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { translate } from '@/i18n/i18n'
import { buildCodexLaunchAccountOptions } from './codex-launch-account-options'

type CodexLaunchAccountMenuProps = {
  worktreeId: string
  shortcut?: string | null
  onLaunch: (providerAccountRef?: ProviderAccountRef) => void
}

export function CodexLaunchAccountMenu({
  worktreeId,
  shortcut,
  onLaunch
}: CodexLaunchAccountMenuProps): React.JSX.Element {
  const target = useAgentDetectionTargetForWorktree(worktreeId)
  const lane = useAppStore((state) => {
    const worktreePath = getIndexedWorktreeById(state.worktreesByRepo ?? {}, worktreeId)?.path
    const pathDistro = parseWslUncPath(worktreePath ?? '')?.distro ?? null
    const localDistro = state.repos
      ? getLocalAgentPreflightContext(state, undefined, undefined, worktreeId)?.wslDistro
      : null
    const wslDistro = pathDistro ?? localDistro ?? null
    return wslDistro ? (`wsl:${wslDistro}` as const) : (`host` as const)
  })
  const [loadRevision, setLoadRevision] = useState(0)
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | {
        status: 'ready'
        accounts: Awaited<ReturnType<typeof fetchProviderAccountsSnapshot>>['codex']['accounts']
      }
  >({ status: 'loading' })

  useEffect(() => {
    let active = true
    if (target === undefined) {
      setState({ status: 'loading' })
      return () => {
        active = false
      }
    }
    if (target.kind === 'ssh') {
      setState({
        status: 'error',
        message: translate(
          'auto.components.tab.bar.CodexLaunchAccountMenu.sshUnsupported',
          'Account selection is unavailable for SSH workspaces.'
        )
      })
      return () => {
        active = false
      }
    }
    setState({ status: 'loading' })
    const loadAccounts = async (): ReturnType<typeof fetchProviderAccountsSnapshot> => {
      if (target.kind === 'runtime') {
        const supported = await runtimeEnvironmentSupportsCapability(
          target.environmentId,
          AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY
        )
        if (!supported) {
          throw new Error(
            translate(
              'auto.components.tab.bar.CodexLaunchAccountMenu.runtimeUnsupported',
              'This runtime only supports Current default. Update or restart Orca to select an account.'
            )
          )
        }
        return fetchProviderAccountsSnapshot({
          activeRuntimeEnvironmentId: target.environmentId
        })
      }
      return fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId: null })
    }
    void loadAccounts()
      .then((snapshot) => {
        if (active) {
          setState({ status: 'ready', accounts: snapshot.codex.accounts })
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : translate(
                    'auto.components.tab.bar.CodexLaunchAccountMenu.loadFailed',
                    'Could not load Codex accounts.'
                  )
          })
        }
      })
    return () => {
      active = false
    }
  }, [loadRevision, target])

  const launchOptions = useMemo(() => {
    if (state.status !== 'ready') {
      return []
    }
    const wslDistro = lane.startsWith('wsl:') ? lane.slice('wsl:'.length) : null
    return buildCodexLaunchAccountOptions(
      state.accounts,
      wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
    )
  }, [lane, state])
  const retry = useCallback(() => setLoadRevision((revision) => revision + 1), [])

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
        title={translate(
          'auto.components.tab.bar.CodexLaunchAccountMenu.title',
          'Launch Codex in a new terminal'
        )}
        aria-label={translate(
          'auto.components.tab.bar.CodexLaunchAccountMenu.trigger',
          'Launch Codex with an account'
        )}
      >
        <AgentIcon agent="codex" size={14} />
        <span className="flex-1">
          {translate('auto.components.tab.bar.CodexLaunchAccountMenu.codex', 'Codex')}
        </span>
        {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[18rem]">
        {state.status === 'loading' ? (
          <>
            <DropdownMenuItem onSelect={() => onLaunch()}>
              {translate(
                'auto.components.tab.bar.CodexLaunchAccountMenu.currentDefault',
                'Current default'
              )}
            </DropdownMenuItem>
            <DropdownMenuItem disabled aria-live="polite">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {translate(
                'auto.components.tab.bar.CodexLaunchAccountMenu.loading',
                'Loading Codex accounts…'
              )}
            </DropdownMenuItem>
          </>
        ) : state.status === 'error' ? (
          <>
            <DropdownMenuItem onSelect={() => onLaunch()}>
              {translate(
                'auto.components.tab.bar.CodexLaunchAccountMenu.currentDefault',
                'Current default'
              )}
            </DropdownMenuItem>
            <DropdownMenuItem disabled className="max-w-[18rem] whitespace-normal">
              {state.message}
            </DropdownMenuItem>
            {target?.kind !== 'ssh' ? (
              <DropdownMenuItem onSelect={retry}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {translate('auto.components.tab.bar.CodexLaunchAccountMenu.retry', 'Retry')}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : (
          launchOptions.map((option) => (
            <DropdownMenuItem
              key={option.key}
              onSelect={() => onLaunch(option.providerAccountRef)}
              className="items-start"
              title={option.description}
            >
              <span className="min-w-0">
                <span className="block truncate">{option.label}</span>
                <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

import React, { useCallback, useState } from 'react'
import {
  AlertTriangle,
  Ellipsis,
  Loader2,
  Pencil,
  Plug,
  PlugZap,
  RefreshCw,
  Settings2,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { describeRuntimeCompatBlock } from '../../../../shared/protocol-compat'
import {
  clearRuntimeCompatibilityCache,
  unwrapRuntimeRpcResult
} from '@/runtime/runtime-rpc-client'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { HostHeaderRow } from './host-section-rows'
import { buildHostHeaderMenuModel } from './host-header-menu-items'
import { HostRenameDialog } from './HostRenameDialog'
import { HostRemoveDialog } from './HostRemoveDialog'
import { resolveHostRemoval } from './host-rename-remove'

function blockedTitle(reason: 'client-too-old' | 'server-too-old'): string {
  return reason === 'server-too-old'
    ? translate(
        'auto.components.sidebar.HostSectionHeaderMenu.5b8b4b6a01',
        'Update server required'
      )
    : translate(
        'auto.components.sidebar.HostSectionHeaderMenu.9b3c1d2e44',
        'Update client required'
      )
}

// Why: SSH and paired runtime hosts share the sidebar model, but Settings keeps
// their management pages separate so each connection type can explain itself.
function openManageHost(row: HostHeaderRow): void {
  const state = useAppStore.getState()
  if (row.kind === 'runtime') {
    const parsed = parseExecutionHostId(row.hostId)
    state.openSettingsTarget({
      pane: 'servers',
      repoId: null,
      sectionId: parsed?.kind === 'runtime' ? parsed.environmentId : undefined
    })
  } else if (row.kind === 'ssh') {
    state.openSettingsTarget({ pane: 'ssh', repoId: null, sectionId: 'ssh' })
  } else {
    state.openSettingsTarget({ pane: 'general', repoId: null })
  }
  state.openSettingsPage()
}

export function HostSectionHeaderMenu({ row }: { row: HostHeaderRow }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const mountedRef = useMountedRef()
  const sshConnected = useAppStore((s) => {
    const parsed = parseExecutionHostId(row.hostId)
    if (parsed?.kind !== 'ssh') {
      return false
    }
    return s.sshConnectionStates.get(parsed.targetId)?.status === 'connected'
  })

  const model = buildHostHeaderMenuModel({
    kind: row.kind,
    health: row.health,
    sshConnected,
    compatibility: row.compatibility
  })
  const removalTarget = resolveHostRemoval(row.hostId)

  const handleManage = useCallback(() => {
    openManageHost(row)
  }, [row])

  const runSshAction = useCallback(
    async (action: 'connect' | 'disconnect') => {
      const parsed = parseExecutionHostId(row.hostId)
      if (parsed?.kind !== 'ssh') {
        return
      }
      setBusy(true)
      try {
        await window.api.ssh[action]({ targetId: parsed.targetId })
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : action === 'connect'
              ? translate(
                  'auto.components.sidebar.HostSectionHeaderMenu.2c29e2de68',
                  'Connection failed'
                )
              : translate(
                  'auto.components.sidebar.HostSectionHeaderMenu.bf07aee59e',
                  'Disconnect failed'
                )
        )
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [mountedRef, row.hostId]
  )

  const handleCheckConnection = useCallback(async () => {
    const parsed = parseExecutionHostId(row.hostId)
    if (parsed?.kind !== 'runtime') {
      return
    }
    setBusy(true)
    // Why: drop any cached "compatible" verdict so the re-probe re-evaluates
    // version skew instead of trusting the prior pass.
    clearRuntimeCompatibilityCache(parsed.environmentId)
    try {
      const response = await window.api.runtimeEnvironments.getStatus({
        selector: parsed.environmentId,
        timeoutMs: 10_000
      })
      const runtimeStatus = unwrapRuntimeRpcResult<RuntimeStatus>(response)
      // Why: feed the probe result into the shared store so the host header and
      // other host pickers reflect this check without a separate fetch.
      useAppStore.getState().setRuntimeEnvironmentStatus(parsed.environmentId, {
        status: runtimeStatus,
        checkedAt: Date.now()
      })
      toast.success(
        translate(
          'auto.components.sidebar.HostSectionHeaderMenu.7f1a2b3c4d',
          '{{value0}} is reachable',
          {
            value0: row.label
          }
        )
      )
    } catch (err) {
      // Why: record the failed probe so the host registry can drop a previously
      // healthy verdict instead of showing stale "compatible" state.
      useAppStore.getState().setRuntimeEnvironmentStatus(parsed.environmentId, {
        status: null,
        checkedAt: Date.now()
      })
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.sidebar.HostSectionHeaderMenu.2c29e2de68',
              'Connection failed'
            )
      )
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }, [mountedRef, row.hostId, row.label])

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/host-header:opacity-100 data-[state=open]:opacity-100"
              aria-label={translate(
                'auto.components.sidebar.HostSectionHeaderMenu.4f2c8a9b10',
                'Host actions for {{value0}}',
                { value0: row.label }
              )}
              // Why: the host header row itself toggles collapse on click;
              // opening the menu must not also fold the section.
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Ellipsis className="size-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.sidebar.HostSectionHeaderMenu.6b7c8d9e10', 'Host actions')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-56">
        {model.blocked && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => openManageHost(row)}
                >
                  <AlertTriangle className="size-3.5" />
                  {blockedTitle(model.blocked.reason)}
                </DropdownMenuItem>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6} className="max-w-72">
                {row.compatibility ? describeRuntimeCompatBlock(row.compatibility) : null}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="truncate text-[11px] font-medium text-muted-foreground">
          {row.label}
        </DropdownMenuLabel>
        {model.actions.includes('rename') && (
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil className="size-3.5" />
            {translate('auto.components.sidebar.HostSectionHeaderMenu.8d1e2f3a4b', 'Rename…')}
          </DropdownMenuItem>
        )}
        {model.actions.includes('ssh-reconnect') && (
          <DropdownMenuItem onSelect={() => void runSshAction('connect')}>
            <Plug className="size-3.5" />
            {translate('auto.components.sidebar.HostSectionHeaderMenu.63f36455cc', 'Reconnect')}
          </DropdownMenuItem>
        )}
        {model.actions.includes('ssh-disconnect') && (
          <DropdownMenuItem onSelect={() => void runSshAction('disconnect')}>
            <PlugZap className="size-3.5" />
            {translate('auto.components.sidebar.HostSectionHeaderMenu.59b553e2aa', 'Disconnect')}
          </DropdownMenuItem>
        )}
        {model.actions.includes('runtime-check-connection') && (
          <DropdownMenuItem onSelect={() => void handleCheckConnection()}>
            <RefreshCw className="size-3.5" />
            {translate(
              'auto.components.sidebar.HostSectionHeaderMenu.2d3e4f5a6b',
              'Check connection'
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleManage}>
          <Settings2 className="size-3.5" />
          {translate('auto.components.sidebar.HostSectionHeaderMenu.3c4d5e6f7a', 'Manage host…')}
        </DropdownMenuItem>
        {model.actions.includes('remove') && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => setRemoveOpen(true)}
            >
              <Trash2 className="size-3.5" />
              {translate(
                'auto.components.sidebar.HostSectionHeaderMenu.6e7f8a9b0c',
                'Remove host…'
              )}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
      <HostRenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        hostId={row.hostId}
        derivedLabel={row.label}
      />
      {removalTarget && (
        <HostRemoveDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          hostId={row.hostId}
          label={row.label}
          target={removalTarget}
        />
      )}
    </DropdownMenu>
  )
}

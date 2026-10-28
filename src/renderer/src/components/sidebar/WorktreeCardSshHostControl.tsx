import { useCallback } from 'react'
import { Loader2, Server, ServerOff } from 'lucide-react'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  connectRuntimeEnvironmentSshTarget,
  resyncRuntimeEnvironmentSshTargets
} from '@/runtime/runtime-environment-ssh-state'
import { canConnectSshStatus, isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { sshConnectingLabel, sshConnectVerb } from '@/ssh/ssh-connect-verb'
import { SSH_RECONNECT_UI_TIMEOUT_MS, withUiConnectTimeout } from '@/ssh/ssh-connect-ui-timeout'
import {
  isSshConnectInFlight,
  trackSshConnect,
  useSshConnectInFlight
} from '@/ssh/ssh-connect-in-flight'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

type WorktreeCardSshHostControlProps = {
  targetId: string
  /** Card passes `sshTargetLabel || repo.displayName` — the selector can return a bare target id. */
  targetLabel: string
  /** Null for runtime-owned targets: renders the passive connected glyph, as before. */
  status: SshConnectionStatus | null
  targetRemoved: boolean
  /** Non-null when the SSH target belongs to a remote Orca server; routes connect to that runtime. */
  sshOwnerEnvironmentId: string | null
  /** Use only the accessible label when dense rows cannot fit visible text. */
  iconOnly: boolean
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
}

// Match neighboring 16px pills in every state so reconnecting cannot change row height.
const PILL_BASE =
  'h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none has-[>svg]:!px-0.5'
const PILL_QUIET =
  'text-muted-foreground border border-worktree-sidebar-border bg-worktree-sidebar shadow-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:border-worktree-sidebar-border focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring'
const PILL_FAILED =
  'text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive focus-visible:border-destructive/40 focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring'

function PassiveGlyph({
  icon,
  tooltip,
  accessibleName,
  targetLabel
}: {
  icon: React.ReactNode
  tooltip: string
  accessibleName: string
  targetLabel: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 inline-flex items-center" data-ssh-target-label={targetLabel}>
          {icon}
          <span className="sr-only">{accessibleName}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardSshHostControl({
  targetId,
  targetLabel,
  status,
  targetRemoved,
  sshOwnerEnvironmentId,
  iconOnly,
  onPointerDown
}: WorktreeCardSshHostControlProps): React.JSX.Element | null {
  const setSshConnectionState = useAppStore((store) => store.setSshConnectionState)
  // Share in-flight state across all host surfaces; store IPC lags the initial click.
  const inFlight = useSshConnectInFlight(targetId)

  const handleConnect = useCallback(async () => {
    if (isSshConnectInFlight(targetId) || isConnectingSshStatus(status)) {
      return
    }
    try {
      if (sshOwnerEnvironmentId) {
        await trackSshConnect(
          targetId,
          connectRuntimeEnvironmentSshTarget(sshOwnerEnvironmentId, targetId)
        )
      } else {
        // Track backend connection beyond the UI timeout so another click cannot raise duplicate credential prompts.
        const connectState = await withUiConnectTimeout(
          trackSshConnect(targetId, window.api.ssh.connect({ targetId })),
          SSH_RECONNECT_UI_TIMEOUT_MS
        )
        if (connectState) {
          // Publish early connection results because deferred PTY reattach may precede state-change IPC.
          setSshConnectionState(targetId, connectState)
        }
      }
    } catch (err) {
      toastSshConnectFailure(
        targetId,
        err,
        translate(
          'auto.components.sidebar.WorktreeCardSshHostControl.connectFailed',
          'SSH connection failed'
        ),
        sshOwnerEnvironmentId
      )
      // Refresh stale target metadata after failure; apply targets before removed labels so partial refresh can still converge.
      if (sshOwnerEnvironmentId) {
        void resyncRuntimeEnvironmentSshTargets(sshOwnerEnvironmentId).catch(() => {})
      } else {
        void (async () => {
          const targets = await window.api.ssh.listTargets()
          useAppStore.getState().setSshTargetsMetadata(targets)
          const removedLabels = await window.api.ssh.listRemovedTargetLabels()
          useAppStore.getState().setRemovedSshTargetLabels(removedLabels)
        })().catch(() => {})
      }
    }
  }, [setSshConnectionState, sshOwnerEnvironmentId, status, targetId])

  // Live connection outranks stale removal; runtime-owned null status stays passive without claiming disconnection.
  if (status === null || status === 'connected') {
    return (
      <PassiveGlyph
        targetLabel={targetLabel}
        icon={<Server className="size-3 text-muted-foreground" />}
        tooltip={translate(
          'auto.components.sidebar.WorktreeCardSshHostControl.connectedTooltip',
          'Project on SSH host'
        )}
        accessibleName={translate(
          'auto.components.sidebar.WorktreeCardSshHostControl.connectedName',
          'Project on SSH host {{value0}}',
          { value0: targetLabel }
        )}
      />
    )
  }

  // Removed hosts cannot reconnect; suppress failing Connect actions and treat removal as settled, not actionable error.
  if (targetRemoved) {
    return (
      <PassiveGlyph
        targetLabel={targetLabel}
        icon={<ServerOff className="size-3 text-muted-foreground" />}
        tooltip={translate(
          'auto.components.sidebar.WorktreeCardSshHostControl.removedTooltip',
          'SSH host removed — reconnect unavailable'
        )}
        accessibleName={translate(
          'auto.components.sidebar.WorktreeCardSshHostControl.removedName',
          'SSH host {{value0}} was removed',
          { value0: targetLabel }
        )}
      />
    )
  }

  const connecting = inFlight || isConnectingSshStatus(status)
  const canConnect = canConnectSshStatus(status)
  if (!connecting && !canConnect) {
    return null
  }

  const failed = status === 'error' || status === 'reconnection-failed' || status === 'auth-failed'
  const label = connecting ? sshConnectingLabel() : sshConnectVerb(status)
  const accessibleName = connecting
    ? translate(
        'auto.components.sidebar.WorktreeCardSshHostControl.connectingName',
        'Connecting to SSH host {{value0}}',
        { value0: targetLabel }
      )
    : status === 'auth-failed'
      ? translate(
          'auto.components.sidebar.WorktreeCardSshHostControl.authFailedName',
          'Reconnect SSH host {{value0}} — authentication failed',
          { value0: targetLabel }
        )
      : failed
        ? translate(
            'auto.components.sidebar.WorktreeCardSshHostControl.retryName',
            'Retry SSH connection to {{value0}}',
            { value0: targetLabel }
          )
        : translate(
            'auto.components.sidebar.WorktreeCardSshHostControl.connectName',
            'Connect to SSH host {{value0}}',
            { value0: targetLabel }
          )
  const tooltip = connecting
    ? accessibleName
    : status === 'auth-failed'
      ? translate(
          'auto.components.sidebar.WorktreeCardSshHostControl.authFailedTooltip',
          '{{value0}} · authentication failed',
          { value0: targetLabel }
        )
      : failed
        ? translate(
            'auto.components.sidebar.WorktreeCardSshHostControl.failedTooltip',
            '{{value0}} · connection failed',
            { value0: targetLabel }
          )
        : accessibleName

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          // Override icon-xs’s 24px size so dense cards keep the shared 16px row height.
          className={cn(
            PILL_BASE,
            failed ? PILL_FAILED : PILL_QUIET,
            iconOnly && 'w-4 justify-center !px-0 has-[>svg]:!px-0'
          )}
          aria-label={accessibleName}
          data-ssh-target-label={targetLabel}
          aria-busy={connecting || undefined}
          // Keep aria-disabled clickable to retain focus/tooltips and prevent second clicks falling through to card actions.
          aria-disabled={connecting || undefined}
          onPointerDown={onPointerDown}
          onKeyDown={(event) => {
            // Stop activation keys before sidebar terminal-focus handling steals the button’s activation.
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
            }
          }}
          onClick={(event) => {
            event.stopPropagation()
            event.preventDefault()
            if (connecting) {
              return
            }
            void handleConnect()
          }}
        >
          {connecting ? (
            <Loader2 className="size-2.5 animate-spin motion-reduce:animate-none" />
          ) : (
            iconOnly && <ServerOff className="size-2.5" />
          )}
          {!iconOnly && <span className="text-left">{label}</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

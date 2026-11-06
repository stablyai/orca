import React from 'react'
import { Server, ServerOff } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorktreeCardController } from './workspace-card/controller/use-worktree-card-controller'

export type WorktreeCardHost = {
  label: string
  kind: 'ssh' | 'runtime'
  /** The link to the host is down; agent state on the card is the last seen. */
  down: boolean
}

/** The computer a remote workspace runs on; local workspaces have none. */
export function getWorktreeCardHost(card: WorktreeCardController): WorktreeCardHost | null {
  const {
    repo,
    parsedRepoHost,
    sshTargetLabel,
    sshStatus,
    isRuntimeDisconnected,
    runtimeHostLabel
  } = card
  if (repo?.connectionId) {
    return {
      label: sshTargetLabel || repo.displayName,
      kind: 'ssh',
      down: sshStatus != null && sshStatus !== 'connected'
    }
  }
  if (parsedRepoHost?.kind === 'runtime') {
    return {
      label: runtimeHostLabel ?? translate('sidebar.cardSlot.orcaServer', 'Orca server'),
      kind: 'runtime',
      down: isRuntimeDisconnected
    }
  }
  return null
}

function hostTooltip(host: WorktreeCardHost): string {
  if (host.kind === 'runtime') {
    return host.down
      ? translate(
          'auto.components.sidebar.WorktreeCard.runtimeHostDisconnectedNamed',
          '{{hostName}} disconnected',
          { hostName: host.label }
        )
      : translate(
          'auto.components.sidebar.WorktreeCard.runtimeHostProjectNamed',
          'Project on {{hostName}}',
          {
            hostName: host.label
          }
        )
  }
  return translate(
    'auto.components.sidebar.WorktreeCardSshHostControl.connectedName',
    'Project on SSH host {{value0}}',
    { value0: host.label }
  )
}

/** Muted machine name after the title, so every remote card says which computer it's on. */
export function WorktreeCardHostName({ host }: { host: WorktreeCardHost }): React.JSX.Element {
  const Icon = host.down ? ServerOff : Server
  return (
    <span
      className={cn(
        'inline-flex max-w-24 shrink-0 items-center gap-0.5 text-3xs leading-none',
        host.down ? 'text-destructive' : 'text-muted-foreground/70'
      )}
      title={hostTooltip(host)}
      data-worktree-card-host=""
    >
      <Icon className="size-2.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{host.label}</span>
    </span>
  )
}

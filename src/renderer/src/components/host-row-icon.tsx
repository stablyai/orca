import React from 'react'
import { Box, Cloud, Monitor, Server } from 'lucide-react'

import { cn } from '@/lib/class-names'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { CloudStateDot } from '@/components/orca-cloud/CloudStateDot'
import { CloudStatusGlyph, type CloudGlyphState } from '@/components/orca-cloud/CloudStatusGlyph'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostVmState } from '../../../shared/execution-host/execution-host-health'

/** Where a workspace runs. Cloud means Orca Cloud and nothing else; recipe VMs are a Box. */
export type HostGlyphKind = 'local' | 'ssh' | 'orca-server' | 'recipe-vm' | 'orca-cloud'

const GLYPH: Record<HostGlyphKind, typeof Cloud> = {
  local: Monitor,
  ssh: Server,
  'orca-server': Server,
  'recipe-vm': Box,
  'orca-cloud': Cloud
}

const SIZE = { 12: 'size-3', 14: 'size-3.5', 16: 'size-4' } as const

/**
 * The one host glyph every surface puts before a workspace name. Orca Cloud shows its state in the
 * cloud itself (fill and colour, no badge); a recipe VM's state rides on its box as a corner dot.
 */
export function HostGlyph({
  kind,
  size = 12,
  state,
  badgeRingClassName = 'bg-worktree-sidebar',
  className,
  label
}: {
  kind: HostGlyphKind
  size?: 12 | 14 | 16
  state?: CloudGlyphState | null
  /** The badge sits in a ring of the surface's background; pass that background here. */
  badgeRingClassName?: string
  className?: string
  /** Accessible name, only where no adjacent text names the host. */
  label?: string
}): React.JSX.Element {
  const Icon = GLYPH[kind]
  if (kind === 'orca-cloud' && state) {
    return (
      <span
        data-host-glyph={kind}
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        className={cn('relative inline-flex shrink-0', SIZE[size], className)}
      >
        <CloudStatusGlyph state={state} size={size} />
      </span>
    )
  }
  const badgeState = state && isDotState(state) ? state : null
  return (
    <span
      data-host-glyph={kind}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('relative inline-flex shrink-0 text-muted-foreground', SIZE[size], className)}
    >
      <Icon className={SIZE[size]} aria-hidden="true" />
      {badgeState ? (
        <span
          className={cn(
            'absolute -right-1 -bottom-1 inline-flex items-center justify-center rounded-full',
            size === 12 ? 'size-2.5' : 'size-[11px]',
            badgeRingClassName
          )}
        >
          <CloudStateDot state={badgeState} size={size === 12 ? 'badge' : 'md'} />
        </span>
      ) : null}
    </span>
  )
}

function isDotState(state: CloudGlyphState): state is CloudDotState {
  return state !== 'goingToSleep' && state !== 'restarting'
}

/** A recipe VM's lifecycle on the same dot vocabulary as Orca Cloud (null = running). */
export function vmStateToDot(state: ExecutionHostVmState | null): CloudDotState {
  switch (state) {
    case 'provisioning':
      return 'starting'
    case 'suspended':
      return 'sleeping'
    case 'waking':
      return 'waking'
    case 'resume_failed':
      return 'wakeFailed'
    case 'provision_failed':
      return 'failed'
    case null:
      return 'running'
  }
}

/** The local machine isn't a server — a monitor glyph reads as "this computer". */
export function HostRowIcon({
  hostId,
  className
}: {
  hostId: ExecutionHostId
  className?: string
}): React.JSX.Element {
  const Icon = hostId === LOCAL_EXECUTION_HOST_ID ? Monitor : Server
  return <Icon className={className ?? 'size-3.5 shrink-0 text-muted-foreground'} />
}

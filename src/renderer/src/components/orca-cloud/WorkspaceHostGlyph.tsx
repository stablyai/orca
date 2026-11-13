import React from 'react'
import { useAppStore } from '@/store'
import { HostGlyph, vmStateToDot, type HostGlyphKind } from '@/components/host-row-icon'
import { selectEphemeralVmWorkspaceState } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'

/** True when the execution host is an Orca Cloud sandbox (an ephemeral-vm runtime named for it). */
export function useIsOrcaCloudHost(hostId: string | null | undefined): boolean {
  return useAppStore((state) => {
    const parsed = parseExecutionHostId(hostId ?? undefined)
    if (parsed?.kind !== 'runtime') {
      return false
    }
    const environment = state.runtimeEnvironments.find((entry) => entry.id === parsed.environmentId)
    return environment ? isOrcaCloudRuntimeEnvironment(environment) : false
  })
}

/** Host kind for an execution host id, before Orca Cloud and recipe VMs are known. */
export function hostGlyphKindForHostId(hostId: string | null | undefined): HostGlyphKind {
  const parsed = parseExecutionHostId(hostId ?? undefined)
  return parsed?.kind === 'ssh' ? 'ssh' : parsed?.kind === 'runtime' ? 'orca-server' : 'local'
}

/**
 * The host glyph for one workspace outside the sidebar card (palette, hover cards, composer
 * footer): Orca Cloud and recipe VMs carry their live state as a badge; the rest by host id.
 */
export function WorkspaceHostGlyph({
  worktreeId,
  hostId,
  size = 12,
  hideLocal = false,
  badgeRingClassName,
  className
}: {
  worktreeId: string
  hostId?: string | null
  size?: 12 | 14 | 16
  /** Lists where every workspace is local drop the glyph rather than show Monitor everywhere. */
  hideLocal?: boolean
  badgeRingClassName?: string
  className?: string
}): React.JSX.Element | null {
  const cloud = useCloudWorkspaceView(worktreeId, { pairedRows: true })
  const vmDot = useAppStore((state) =>
    state.ephemeralVmRuntimesByWorkspaceId?.[worktreeId]
      ? vmStateToDot(selectEphemeralVmWorkspaceState(state, worktreeId))
      : null
  )
  const kind: HostGlyphKind = cloud.isCloud
    ? 'orca-cloud'
    : vmDot
      ? 'recipe-vm'
      : hostGlyphKindForHostId(hostId)
  if (kind === 'local' && hideLocal) {
    return null
  }
  return (
    <HostGlyph
      kind={kind}
      size={size}
      state={cloud.isCloud ? cloud.state : vmDot}
      badgeRingClassName={badgeRingClassName}
      className={className}
    />
  )
}

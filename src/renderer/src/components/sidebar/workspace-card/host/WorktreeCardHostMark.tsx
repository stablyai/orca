import React from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { HostGlyph, vmStateToDot } from '@/components/host-row-icon'
import { CloudWorkspaceMarkSlot } from '@/components/orca-cloud/CloudWorkspaceMarkSlot'
import { cloudStateLabel } from '@/components/orca-cloud/cloud-state-copy'
import { useCloudWorkspaceView } from '@/components/orca-cloud/use-cloud-workspace-view'
import { useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useIsWorktreeGoingToSleep } from '@/lib/worktree-sleep-view'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { selectEphemeralVmWorkspaceState } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'

/**
 * Local-only users never see a host slot: it appears once any workspace runs elsewhere (SSH,
 * an Orca server, a recipe VM or Orca Cloud), and then every row gets one so titles align.
 */
export function useSidebarShowsHostSlot(): boolean {
  const anyCloud = useCloudWorkspace((state) => state.ids.size > 0)
  const anyRemote = useAppStore(
    (state) =>
      state.repos.some(
        (repo) =>
          Boolean(repo.connectionId) ||
          parseExecutionHostId(repo.executionHostId)?.kind === 'runtime'
      ) || Object.keys(state.ephemeralVmRuntimesByWorkspaceId ?? {}).length > 0
  )
  return anyCloud || anyRemote
}

/** Recipe VM (Box + lifecycle badge) or this computer (Monitor) in the shared 12px slot. */
function LocalOrVmGlyph({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  // A primitive, so rows re-render only when this VM's state changes.
  const vmDot = useAppStore((state) =>
    state.ephemeralVmRuntimesByWorkspaceId?.[worktreeId]
      ? vmStateToDot(selectEphemeralVmWorkspaceState(state, worktreeId))
      : null
  )
  const showSlot = useSidebarShowsHostSlot()
  if (vmDot) {
    return <HostGlyph kind="recipe-vm" size={12} state={vmDot} />
  }
  return showSlot ? <HostGlyph kind="local" size={12} /> : null
}

/**
 * The card's one host mark: SSH keeps its connection control, Orca Cloud its live mark, an Orca
 * server its runtime mark; recipe VMs and this computer get the plain glyph.
 */
export function WorktreeCardHostMark({
  worktreeId,
  hostId,
  sshControl,
  runtimeMark,
  onPointerDown
}: {
  worktreeId: string
  /** The execution host: an Orca Cloud sandbox's server gets the cloud glyph from the first frame. */
  hostId?: string | null
  /** Set for SSH repos: the connection control replaces the glyph. */
  sshControl?: React.ReactNode
  /** Set for Orca server repos. */
  runtimeMark?: React.ReactNode
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
}): React.JSX.Element | null {
  if (sshControl) {
    // A fixed 12px column (the 16px control overhangs it evenly) so titles line up across hosts.
    return <span className="inline-flex w-3 shrink-0 justify-center">{sshControl}</span>
  }
  return (
    <CloudWorkspaceMarkSlot
      workspaceId={worktreeId}
      hostId={hostId}
      onPointerDown={onPointerDown}
      fallback={runtimeMark ?? <LocalOrVmGlyph worktreeId={worktreeId} />}
    />
  )
}

const PROBLEM: ReadonlySet<CloudDotState> = new Set(['failed', 'wakeFailed'])

/** Line 2 names a cloud or VM row's state when it is not running ("Asleep · branch"). */
export function WorktreeCardHostStateWord({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const cloud = useCloudWorkspaceView(worktreeId, { pairedRows: true })
  const vmDot = useAppStore((state) =>
    state.ephemeralVmRuntimesByWorkspaceId?.[worktreeId]
      ? vmStateToDot(selectEphemeralVmWorkspaceState(state, worktreeId))
      : null
  )
  const goingToSleep = useIsWorktreeGoingToSleep(worktreeId)
  const t = useTranslate()
  const state = cloud.isCloud ? cloud.state : vmDot
  // Sleep chosen and not ended: "Going to sleep…" until the sleep ends, driven by the same flag as
  // the view, so the row never says Asleep (the record flips to suspended first) before the view
  // does. A failure still names itself.
  const going = cloud.isCloud && goingToSleep && !(state && PROBLEM.has(state))
  // Unknown is not a state to name (the panel shows a placeholder until the first read).
  if (!going && (!state || state === 'running' || state === 'unknown')) {
    return null
  }
  return (
    <>
      <span
        data-host-state-word={going ? 'goingToSleep' : state}
        className={cn(
          'shrink-0 text-[11px] leading-none',
          state && PROBLEM.has(state) ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {going || !state
          ? t('orcaCloudWorkspace.state.goingToSleep', 'Going to sleep…')
          : cloudStateLabel(state, t)}
      </span>
      {/* Its own element so CSS hides it when nothing follows on line 2 ("Couldn't start ·"
          alone reads as cut off), whatever does or doesn't render after it. */}
      <span
        aria-hidden="true"
        data-host-state-separator=""
        className="-ml-1 shrink-0 text-[11px] leading-none text-muted-foreground last:hidden"
      >
        ·
      </span>
    </>
  )
}

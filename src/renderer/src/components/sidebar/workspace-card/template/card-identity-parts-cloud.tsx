// Orca Cloud side of the card's identity parts: the cloud marks beside the title, no primary
// badge on a cloud workspace's own checkout, and the one host mark slot (with Orca Cloud in it).
import React from 'react'
import { getWorktreeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { useIsCloudHostRow } from '@/lib/orca-cloud/cloud-host-rows'
import { WorktreeCardRuntimeHostMark } from '../identity/worktree-card-header-items'
import { WorktreeCardHostMark, WorktreeCardHostStateWord } from '../host/WorktreeCardHostMark'
import { CloudAgentHeldMark } from '@/components/orca-cloud/CloudAgentHeldMark'
import { CloudMemoryPressureMark } from '@/components/orca-cloud/CloudMemoryPressureMark'
import { cardElement } from './card-template-compiler'

type Card = WorktreeCardController
const part = cardElement<Card>
type SshControl = (props: Readonly<Record<string, unknown>>, card: Card) => React.ReactNode

/** The title with the cloud marks after it; hidden while the title is being renamed. */
export function withCloudTitleMarks(
  title: React.JSX.Element,
  card: Pick<Card, 'titleRenaming' | 'worktree'>
): React.JSX.Element {
  return (
    <>
      {title}
      {/* The agent waits on its pane's strip (Orca Cloud): this mark is the signal away. */}
      {card.titleRenaming ? null : <CloudAgentHeldMark worktreeId={card.worktree.id} />}
      {/* MEMGUARD: the cloud VM is short of memory. */}
      {card.titleRenaming ? null : <CloudMemoryPressureMark worktreeId={card.worktree.id} />}
    </>
  )
}

/**
 * An Orca Cloud workspace's own checkout (owned or PAIRED) IS the workspace, not a repo's primary
 * checkout: no "primary" badge or star on it.
 */
export function NotOnCloudRow({
  worktree,
  children
}: {
  worktree: WorktreeCardController['worktree']
  children: React.ReactNode
}): React.JSX.Element | null {
  return useIsCloudHostRow(worktree) ? null : <>{children}</>
}

/** The host-mark parts; `sshControl` is the identity parts' own SSH control. */
export function createCardHostParts(sshControl: SshControl) {
  return {
    // The one host mark (SSH, Orca server, recipe VM, Orca Cloud or this computer) in a 12px slot.
    HostMark: part(['runtime'], (props, _children, card) => (
      <WorktreeCardHostMark
        worktreeId={card.worktree.id}
        hostId={getWorktreeExecutionHostId(card.worktree, card.repo)}
        onPointerDown={card.stopQuickActionPointerPropagation}
        // Always icon-only in the 12px slot; classic cards show Connect on line 2 (SshConnect).
        sshControl={sshControl({ iconOnly: true }, card)}
        runtimeMark={
          props.runtime === true ? (
            <WorktreeCardRuntimeHostMark
              disconnected={card.isRuntimeDisconnected}
              hostLabel={card.runtimeHostLabel}
            />
          ) : undefined
        }
      />
    )),
    SshConnect: part([], (_props, _children, card) =>
      sshControl({ iconOnly: false, actionOnly: true }, card)
    ),
    HostStateWord: part([], (_props, _children, card) => (
      <WorktreeCardHostStateWord worktreeId={card.worktree.id} />
    ))
  }
}

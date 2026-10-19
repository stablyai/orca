import type { CreateWorktreeResult } from './worktree/create-types'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from './worktree/launch-types'
import type { SshConnectionState } from './ssh-types'
import type { TerminalSideEffectBatch } from './terminal-side-effect-facts'
import type { RuntimeNativeChatLaunchDraftResolution } from './runtime-types'
import type { RuntimeNavigationTarget } from './runtime-navigation'
import type { WorktreeSortOrderUpdate } from './worktree/sort-order-update'
import type { SidebarInputsChangedEvent } from './sidebar-list/sidebar-inputs-feed-contract'

export type RuntimeClientEvent =
  | { type: 'reposChanged' }
  /** The Workspace options UI state changed; a mirroring phone re-reads it. */
  | { type: 'workspaceViewChanged' }
  | {
      type: 'worktreesChanged'
      repoId: string
      sortOrderOnly?: boolean
      // Why: lets a client patch an order save in place instead of refetching the repo (#27268).
      sortOrders?: WorktreeSortOrderUpdate[]
    }
  | ({ type: 'nativeChatLaunchDraftResolved' } & RuntimeNativeChatLaunchDraftResolution)
  | { type: 'terminalSideEffects'; batch: TerminalSideEffectBatch }
  /** Only while this host's own phone reads the sidebar feed; every other reader drops it. */
  | SidebarInputsChangedEvent
  // Why: SSH connections live on the runtime host; paired clients have no IPC
  // channel for ssh:state-changed, so without this event their reconnect
  // overlays never learn the host connected (STA-1468).
  | { type: 'sshStateChanged'; targetId: string; state: SshConnectionState }
  | {
      type: 'worktreeTerminalSleepState'
      worktreeId: string
      generation: number
      phase: 'started' | 'committed' | 'cancelled' | 'woken'
      ptyIds: string[]
      terminalHandles: string[]
    }
  // Why: automation stores are authority-owned, so clients cannot learn about a
  // run/usage/definition write without the owning authority announcing it.
  | {
      type: 'automationsChanged'
      selector?: { kind: 'self' } | { kind: 'ssh'; targetId: string } | { kind: 'orphan' }
      reason?: 'definition' | 'run' | 'usage'
    }
  | {
      type: 'linearLinkedIssueUpdated'
      worktreeId: string
      identifier: string
      workspaceId: string
    }
  | {
      type: 'activateWorktree'
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: WorktreeStartupLaunch
      defaultTabs?: WorktreeDefaultTabsLaunch
      providesInitialSurface?: boolean
      /** Absent on older hosts; clients must not infer navigation intent from a broadcast. */
      navigation?: RuntimeNavigationTarget
    }

export type RuntimeClientEventStreamMessage =
  | ({ type: 'ready'; subscriptionId: string } & {
      snapshot?: {
        repos?: unknown[]
        sshStates?: { targetId: string; state: SshConnectionState }[]
      }
    })
  | RuntimeClientEvent
  | { type: 'end' }

export type RuntimeActivateWorktreeEvent = Extract<RuntimeClientEvent, { type: 'activateWorktree' }>

export type AutomationsChangedEvent = Extract<RuntimeClientEvent, { type: 'automationsChanged' }>

/** Publisher payload; `selector` scoping is added by a later host-scope step. */
export type AutomationsChangedPayload = Omit<AutomationsChangedEvent, 'type'>

export type PublishAutomationsChanged = (payload: AutomationsChangedPayload) => void

export function toRuntimeActivateWorktreeEvent(
  repoId: string,
  worktreeId: string,
  setup?: CreateWorktreeResult['setup'],
  startup?: WorktreeStartupLaunch,
  defaultTabs?: CreateWorktreeResult['defaultTabs'],
  navigation?: RuntimeNavigationTarget,
  providesInitialSurface?: boolean
): RuntimeActivateWorktreeEvent {
  return {
    type: 'activateWorktree',
    repoId,
    worktreeId,
    ...(navigation ? { navigation } : {}),
    ...(setup ? { setup } : {}),
    ...(startup ? { startup } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(providesInitialSurface ? { providesInitialSurface } : {})
  }
}

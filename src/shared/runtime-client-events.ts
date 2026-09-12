import type { CreateWorktreeResult } from './worktree/create-types'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from './worktree/launch-types'
import type { SshConnectionState } from './ssh-types'
import type { TerminalSideEffectBatch } from './terminal-side-effect-facts'
import type { RuntimeNativeChatLaunchDraftResolution } from './runtime-types'

export type RuntimeClientEvent =
  | { type: 'reposChanged' }
  | { type: 'worktreesChanged'; repoId: string }
  | ({ type: 'nativeChatLaunchDraftResolved' } & RuntimeNativeChatLaunchDraftResolution)
  | { type: 'terminalSideEffects'; batch: TerminalSideEffectBatch }
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
  defaultTabs?: CreateWorktreeResult['defaultTabs']
): RuntimeActivateWorktreeEvent {
  return {
    type: 'activateWorktree',
    repoId,
    worktreeId,
    ...(setup ? { setup } : {}),
    ...(startup ? { startup } : {}),
    ...(defaultTabs ? { defaultTabs } : {})
  }
}

import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { WindowVisibilitySubscriptionParking } from '../window-visibility-subscription-parking'
import type { SessionTabsSnapshotHandler } from './visibility-resume-types'

type Ref<T> = { current: T }

export type ActiveSubscriptionArgs = {
  activeWorktreeId: string | null
  activeWorktreeRuntimeEnvironmentId: string | null | undefined
  activeWorktreeRuntimeConnectionGeneration: number
  activeWorktreeRuntimePairingRevision: number | undefined
  workspaceSessionReady: boolean
  projectSnapshot?: (snapshot: RuntimeMobileSessionTabsResult) => RuntimeMobileSessionTabsResult
  onError?: (error: unknown) => void
  visibilitySnapshotReceipt: Ref<SessionTabsSnapshotHandler<void>>
  visibilitySnapshotApply: Ref<SessionTabsSnapshotHandler<boolean>>
  visibilitySnapshotAccepted: Ref<SessionTabsSnapshotHandler<void>>
}

export type ActiveSessionTabsSubscription = WindowVisibilitySubscriptionParking & {
  /** The worktree became selected again while its stream stayed warm. */
  reconsiderSelected: () => void
}

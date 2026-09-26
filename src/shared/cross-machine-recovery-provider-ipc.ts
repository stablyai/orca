import type {
  CcSyncErrorCode,
  CcSyncInspect,
  CcSyncList,
  CcSyncPickup,
  CcSyncProgress,
  CcSyncStatus
} from './cross-machine-recovery-provider-types'

/** Failures Orca detects itself, beside the codes the provider reports in its JSON envelope. */
export type CrossMachineRecoveryBridgeErrorCode =
  | 'not-installed'
  | 'timeout'
  | 'output-too-large'
  | 'invalid-output'
  | 'provider-failed'

export type CrossMachineRecoveryProviderError = {
  code: CcSyncErrorCode | CrossMachineRecoveryBridgeErrorCode
  message: string
}

export type CrossMachineRecoveryProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CrossMachineRecoveryProviderError }

export type CrossMachineRecoveryListArgs = { source?: string; repo?: string; all?: boolean }

export type CrossMachineRecoveryInspectArgs = { selector: string; checkpoint?: string }

export type CrossMachineRecoveryDivergence = 'refuse' | 'keep-local' | 'replace' | 'fork'

export type CrossMachineRecoveryPickupArgs = {
  operationId: string
  selector: string
  checkpoint?: string
  resume: string[]
  onDivergence?: CrossMachineRecoveryDivergence
}

export type CrossMachineRecoveryPickupProgressEvent = {
  operationId: string
  progress: CcSyncProgress
}

/** Every provider call carries the desktop's stable client id so the provider can prefer its view. */
export type WithClientInstanceId<T> = T & { clientInstanceId: string }

export type CrossMachineRecoveryApi = {
  isSupported: boolean
  getClientInstanceId: () => Promise<string>
  status: () => Promise<CrossMachineRecoveryProviderResult<CcSyncStatus>>
  list: (
    args?: CrossMachineRecoveryListArgs
  ) => Promise<CrossMachineRecoveryProviderResult<CcSyncList>>
  inspect: (
    args: CrossMachineRecoveryInspectArgs
  ) => Promise<CrossMachineRecoveryProviderResult<CcSyncInspect>>
  pickup: (
    args: CrossMachineRecoveryPickupArgs
  ) => Promise<CrossMachineRecoveryProviderResult<CcSyncPickup>>
  cancel: (operationId: string) => Promise<void>
  onPickupProgress: (
    listener: (event: CrossMachineRecoveryPickupProgressEvent) => void
  ) => () => void
}

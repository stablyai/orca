import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NestedRepoTelemetryRuntimeKind } from '../../../../shared/nested-repo-telemetry'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { defaultProjectGroupNameForPath, type AddRepoDialogStep } from './add-repo-dialog-types'

type ShowNestedRepoReviewArgs = {
  scan: NestedRepoScanResult
  selectedPath: string
  connectionId: string | null
  attemptId: string
  runtimeKind: NestedRepoTelemetryRuntimeKind
  inProgress: boolean
  scanId: string | null
  runtimeEnvironmentId?: string | null
}

export function useAddRepoNestedReviewState({
  activeRuntimeEnvironmentId,
  cancelNestedRepoScan,
  setStep
}: {
  activeRuntimeEnvironmentId: string | null | undefined
  cancelNestedRepoScan: (
    scanId: string,
    options?: { runtimeEnvironmentId?: string | null }
  ) => Promise<unknown>
  setStep: (step: AddRepoDialogStep) => void
}): {
  nestedScan: NestedRepoScanResult | null
  nestedSelectedPaths: Set<string>
  nestedGroupName: string
  nestedConnectionId: string | null
  nestedAttemptId: string | null
  nestedRuntimeKind: NestedRepoTelemetryRuntimeKind | null
  nestedScanInProgress: boolean
  nestedScanId: string | null
  nestedImportScanId: string | null
  nestedRuntimeEnvironmentId: string | null | undefined
  setNestedSelectedPaths: Dispatch<SetStateAction<Set<string>>>
  setNestedGroupName: Dispatch<SetStateAction<string>>
  setNestedScanInProgress: Dispatch<SetStateAction<boolean>>
  getNestedRepoRuntimeKind: (connectionId: string | null) => NestedRepoTelemetryRuntimeKind
  showNestedRepoReview: (args: ShowNestedRepoReviewArgs) => void
  setActiveNestedScanId: (scanId: string | null, runtimeEnvironmentId?: string | null) => void
  handleStopNestedScan: () => void
  resetNestedRepoReviewState: () => void
} {
  const [nestedScan, setNestedScan] = useState<NestedRepoScanResult | null>(null)
  const [nestedSelectedPaths, setNestedSelectedPaths] = useState<Set<string>>(new Set())
  const [nestedGroupName, setNestedGroupName] = useState('')
  const [nestedConnectionId, setNestedConnectionId] = useState<string | null>(null)
  const [nestedAttemptId, setNestedAttemptId] = useState<string | null>(null)
  const [nestedRuntimeKind, setNestedRuntimeKind] = useState<NestedRepoTelemetryRuntimeKind | null>(
    null
  )
  const [nestedScanInProgress, setNestedScanInProgress] = useState(false)
  const [nestedScanId, setNestedScanId] = useState<string | null>(null)
  const [nestedImportScanId, setNestedImportScanId] = useState<string | null>(null)
  const [nestedRuntimeEnvironmentId, setNestedRuntimeEnvironmentId] = useState<
    string | null | undefined
  >(undefined)
  const nestedScanIdRef = useRef<string | null>(null)
  const nestedScanRuntimeEnvironmentIdRef = useRef<string | null | undefined>(undefined)

  const getNestedRepoRuntimeKind = useCallback(
    (connectionId: string | null): NestedRepoTelemetryRuntimeKind => {
      if (connectionId) {
        return 'ssh'
      }
      return activeRuntimeEnvironmentId?.trim() ? 'runtime' : 'local'
    },
    [activeRuntimeEnvironmentId]
  )

  const showNestedRepoReview = useCallback(
    (args: ShowNestedRepoReviewArgs): void => {
      setNestedScan(args.scan)
      setNestedSelectedPaths(new Set(args.scan.repos.map((repo) => repo.path)))
      setNestedGroupName(
        defaultProjectGroupNameForPath(args.scan.selectedPath || args.selectedPath)
      )
      setNestedConnectionId(args.connectionId)
      setNestedAttemptId(args.attemptId)
      setNestedRuntimeKind(args.runtimeKind)
      setNestedScanInProgress(args.inProgress)
      setNestedImportScanId(args.scanId)
      setNestedRuntimeEnvironmentId(args.runtimeEnvironmentId ?? null)
      setStep('nested')
    },
    [setStep]
  )

  const setActiveNestedScanId = useCallback(
    (scanId: string | null, runtimeEnvironmentId?: string | null): void => {
      nestedScanIdRef.current = scanId
      nestedScanRuntimeEnvironmentIdRef.current = scanId ? runtimeEnvironmentId : undefined
      setNestedScanId(scanId)
    },
    []
  )

  const handleStopNestedScan = useCallback(() => {
    const scanId = nestedScanIdRef.current
    if (!scanId) {
      return
    }
    void cancelNestedRepoScan(scanId, {
      runtimeEnvironmentId: nestedScanRuntimeEnvironmentIdRef.current
    })
  }, [cancelNestedRepoScan])

  const resetNestedRepoReviewState = useCallback((): void => {
    const activeNestedScanId = nestedScanIdRef.current
    if (activeNestedScanId) {
      void cancelNestedRepoScan(activeNestedScanId, {
        runtimeEnvironmentId: nestedScanRuntimeEnvironmentIdRef.current
      })
    }
    setNestedScan(null)
    setNestedSelectedPaths(new Set())
    setNestedGroupName('')
    setNestedConnectionId(null)
    setNestedAttemptId(null)
    setNestedRuntimeKind(null)
    setNestedScanInProgress(false)
    setNestedImportScanId(null)
    setNestedRuntimeEnvironmentId(null)
    setActiveNestedScanId(null)
  }, [cancelNestedRepoScan, setActiveNestedScanId])

  return {
    nestedScan,
    nestedSelectedPaths,
    nestedGroupName,
    nestedConnectionId,
    nestedAttemptId,
    nestedRuntimeKind,
    nestedScanInProgress,
    nestedScanId,
    nestedImportScanId,
    nestedRuntimeEnvironmentId,
    setNestedSelectedPaths,
    setNestedGroupName,
    setNestedScanInProgress,
    getNestedRepoRuntimeKind,
    showNestedRepoReview,
    setActiveNestedScanId,
    handleStopNestedScan,
    resetNestedRepoReviewState
  }
}

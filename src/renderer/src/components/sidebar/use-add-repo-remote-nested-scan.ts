import { useCallback } from 'react'
import { track } from '@/lib/telemetry'
import { buildNestedRepoScanTelemetry } from '../../../../shared/nested-repo-telemetry'
import type { NestedRepoScanResult } from '../../../../shared/types'

export function useAddRepoRemoteNestedScan({
  setActiveNestedScanId,
  showNestedRepoReview
}: {
  setActiveNestedScanId: (scanId: string | null) => void
  showNestedRepoReview: (options: {
    scan: NestedRepoScanResult
    selectedPath: string
    connectionId: string
    attemptId: string
    runtimeKind: 'ssh'
    inProgress: boolean
    scanId: string | null
  }) => void
}) {
  const showRemoteNestedRepoReview = useCallback(
    (
      scan: NestedRepoScanResult,
      selectedPath: string,
      connectionId: string,
      attemptId: string,
      inProgress: boolean,
      scanId: string | null
    ) => {
      setActiveNestedScanId(inProgress ? scanId : null)
      showNestedRepoReview({
        scan,
        selectedPath,
        connectionId,
        attemptId,
        runtimeKind: 'ssh',
        inProgress,
        scanId
      })
    },
    [setActiveNestedScanId, showNestedRepoReview]
  )

  const trackRemoteNestedScanResult = useCallback(
    (scan: NestedRepoScanResult | null, attemptId: string) => {
      track(
        'add_repo_nested_scan_result',
        buildNestedRepoScanTelemetry({
          attemptId,
          surface: 'sidebar',
          runtimeKind: 'ssh',
          scan
        })
      )
    },
    []
  )

  return { showRemoteNestedRepoReview, trackRemoteNestedScanResult }
}

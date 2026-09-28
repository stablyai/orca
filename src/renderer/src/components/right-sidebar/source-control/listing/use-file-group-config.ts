import { useCallback, useEffect, useState } from 'react'
import { joinPath } from '@/lib/path'
import {
  isMissingRuntimePathError,
  readRuntimeFileContent,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { parseOrcaYaml } from '../../../../../../shared/orca-yaml'
import type { SourceControlFileGroup } from '../../../../../../shared/source-control-file-groups'

const EMPTY_GROUPS: SourceControlFileGroup[] = []

/** Reads the active checkout on its owning host; a late reply cannot replace another workspace. */
export function useSourceControlFileGroupConfig({
  settings,
  worktreeId,
  worktreePath,
  connectionId
}: RuntimeFileOperationArgs) {
  const environmentId = settings?.activeRuntimeEnvironmentId
  const key = JSON.stringify([environmentId, connectionId, worktreeId, worktreePath])
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{
    key: string
    groups: SourceControlFileGroup[]
    failed: boolean
  } | null>(null)
  const refreshFileGroups = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    if (!worktreePath) {
      return
    }
    let cancelled = false
    void readRuntimeFileContent({
      settings: { activeRuntimeEnvironmentId: environmentId },
      worktreeId: worktreeId ?? undefined,
      filePath: joinPath(worktreePath, 'orca.yaml'),
      relativePath: 'orca.yaml',
      connectionId,
      expectedExternalSshTargetId: connectionId
    })
      .then((file) => {
        if (!cancelled) {
          setResult({
            key,
            groups: file.isBinary
              ? EMPTY_GROUPS
              : (parseOrcaYaml(file.content)?.sourceControl?.fileGroups ?? EMPTY_GROUPS),
            failed: false
          })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({ key, groups: EMPTY_GROUPS, failed: !isMissingRuntimePathError(error) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, environmentId, key, revision, worktreeId, worktreePath])

  return {
    fileGroups: result?.key === key ? result.groups : EMPTY_GROUPS,
    fileGroupsFailed: result?.key === key && result.failed,
    refreshFileGroups
  }
}

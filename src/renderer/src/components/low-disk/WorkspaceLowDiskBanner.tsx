import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useWindowStreamVisible } from '@/hooks/use-window-stream-visibility'
import { selectWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import {
  readCachedDiskUsage,
  startDiskUsagePoll
} from '@/runtime/hosts/disk-usage/remote-disk-usage-poll'
import { isEphemeralVmRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  worstLowDiskVolume,
  type LowDiskLevel,
  type OrcadDiskUsageResult
} from '../../../../shared/orcad-disk-usage'
import { LowDiskBannerView } from './LowDiskBannerView'

/** The connected VM / Orca Cloud environment behind the active workspace, else null (local, SSH, user servers). */
function selectActiveCloudEnvironmentId(state: AppState): string | null {
  const environmentId = selectWorkspaceRuntimeEnvironmentId(state, state.activeWorktreeId)
  if (!environmentId) {
    return null
  }
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  if (!environment || !isEphemeralVmRuntimeEnvironment(environment)) {
    return null
  }
  const entry = state.runtimeStatusByEnvironmentId.get(environmentId)
  return runtimeHostConnectionStateForEntry(entry) === 'connected' ? environmentId : null
}

function selectRuntimeId(state: AppState, environmentId: string | null): string | null {
  return environmentId
    ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.status?.runtimeId ?? null)
    : null
}

const LEVEL_RANK: Record<LowDiskLevel, number> = { ok: 0, warning: 1, critical: 2 }

/** Polls only while a connected cloud workspace is on screen; local workspaces never poll. */
export function WorkspaceLowDiskBanner({
  visible
}: {
  visible: boolean
}): React.JSX.Element | null {
  const windowVisible = useWindowStreamVisible()
  const environmentId = useAppStore((state) =>
    visible ? selectActiveCloudEnvironmentId(state) : null
  )
  const runtimeId = useAppStore((state) => selectRuntimeId(state, environmentId))
  const [reading, setReading] = useState<{
    environmentId: string
    result: OrcadDiskUsageResult | null
  }>()
  // Dismissed level per environment: a dismissed warning re-appears only if it turns critical.
  const [dismissed, setDismissed] = useState<Readonly<Record<string, LowDiskLevel>>>({})

  const polling = environmentId !== null && windowVisible
  useEffect(() => {
    if (!polling || !environmentId) {
      return
    }
    return startDiskUsagePoll({
      environmentId,
      runtimeId,
      onResult: (result) => setReading({ environmentId, result })
    })
  }, [polling, environmentId, runtimeId])

  if (!environmentId) {
    return null
  }
  // Why the cache: switching back to a workspace shows its last reading before the next poll lands.
  const result =
    reading?.environmentId === environmentId ? reading.result : readCachedDiskUsage(environmentId)
  const worst = result ? worstLowDiskVolume(result.volumes) : null
  if (!worst) {
    return null
  }
  const dismissedLevel = dismissed[environmentId]
  if (dismissedLevel && LEVEL_RANK[dismissedLevel] >= LEVEL_RANK[worst.level]) {
    return null
  }
  return (
    <LowDiskBannerView
      level={worst.level}
      availableBytes={worst.volume.availableBytes}
      totalBytes={worst.volume.totalBytes}
      onDismiss={() => setDismissed((prev) => ({ ...prev, [environmentId]: worst.level }))}
    />
  )
}

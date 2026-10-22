import type { RuntimeMobileSessionTabMove } from '../../../../shared/runtime-types'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '../../store'
import { isWebRuntimeSessionActive } from '../../runtime/web-runtime-session-environment'
import { moveWebRuntimeSessionTab } from '../../runtime/web-runtime-session-tab-move'

export function mirrorWebRuntimeTabMove(
  args: RuntimeMobileSessionTabMove & {
    worktreeId: string
  }
): void {
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(
    useAppStore.getState(),
    args.worktreeId
  )
  if (!isWebRuntimeSessionActive(environmentId)) {
    return
  }
  void moveWebRuntimeSessionTab({
    ...args,
    environmentId
  })
}

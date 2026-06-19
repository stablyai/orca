import type { GlobalSettings } from '../../../../shared/types'
import { isLocalPathOpenBlocked } from '@/lib/local-path-open-guard'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'

export function shouldBlockEditorTabLocalOpen(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  fileRuntimeEnvironmentId: string | null | undefined,
  connectionId: string | null | undefined
): boolean {
  return isLocalPathOpenBlocked(settingsForRuntimeOwner(settings, fileRuntimeEnvironmentId), {
    connectionId
  })
}

import { vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'

type HostFinalization = {
  finalizeRuntimeMobileSessionTabsResult: (
    input: {
      snapshot: RuntimeMobileSessionTabsSnapshot
      tabs: RuntimeMobileSessionTabsResult['tabs']
    },
    host: { sanitizeGroups: () => undefined }
  ) => RuntimeMobileSessionTabsResult
}

// Keep the host-only type graph out of the renderer typecheck.
const { finalizeRuntimeMobileSessionTabsResult } = await vi.importActual<HostFinalization>(
  '../../../../main/runtime/runtime-mobile-session-result-finalization'
)

/** Run terminal fixtures through the host's retirement filter before the renderer consumes them. */
export function finalizeHostTerminalSnapshot(
  snapshot: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  if (snapshot.tabGroups !== undefined || snapshot.tabGroupLayout !== undefined) {
    throw new Error('This fixture only supports ungrouped terminal snapshot finalization')
  }
  return finalizeRuntimeMobileSessionTabsResult(
    { snapshot, tabs: snapshot.tabs },
    { sanitizeGroups: () => undefined }
  )
}

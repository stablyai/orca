import type { RuntimeMobileSessionFileTab } from './runtime-mobile-session-tab-contracts'

/** Names the paired server a row's file or page lives on, for runtimes to keep from other runtimes (#33424). */
export function editorRowHost(file: {
  runtimeEnvironmentId?: string | null
}): Pick<RuntimeMobileSessionFileTab, 'hostRuntimeEnvironmentId'> {
  const hostRuntimeEnvironmentId = file.runtimeEnvironmentId?.trim()
  return hostRuntimeEnvironmentId ? { hostRuntimeEnvironmentId } : {}
}

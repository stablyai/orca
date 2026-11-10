import type { BrowserPage } from '../browser-workspace-types'

export function getBrowserPageRuntimeEnvironmentId(
  page: BrowserPage,
  inferredRuntimeEnvironmentId: string | null | undefined
): string | null {
  if (page.browserRuntimeEnvironmentId !== undefined) {
    return page.browserRuntimeEnvironmentId?.trim() || null
  }
  return inferredRuntimeEnvironmentId?.trim() || null
}

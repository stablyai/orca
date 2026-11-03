import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OpenInApplication } from '../../../shared/ui-chrome-types'

export const NO_OPEN_IN_APPLICATIONS: readonly OpenInApplication[] = []

/** The app a File Explorer click opens files in; null means the Orca editor, including for a removed app. */
export function getFileExplorerOpenInApplication(
  settings: Pick<GlobalSettings, 'openInApplications' | 'fileExplorerOpenInApplicationId'> | null
): OpenInApplication | null {
  const id = settings?.fileExplorerOpenInApplicationId
  if (!id) {
    return null
  }
  return settings.openInApplications?.find((application) => application.id === id) ?? null
}

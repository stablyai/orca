import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { SettingsProject, SettingsProjectRemovalScope } from './settings-project-types'
import { getProjectGroupKey } from '../../../../shared/project-grouping'

function getCheckoutSelectionKey(projectId: string, repoId: string): string {
  return `${projectId}::setup:${repoId}`
}

/** Carry the latest explicit host pick across split/unsplit selection keys while that host remains present. */
export function getSettingsEntryHostSelection(
  settingsProject: SettingsProject,
  hostSelection: Readonly<Record<string, ExecutionHostId>>,
  setupSelection: Readonly<Record<string, string>>
): { hostId: ExecutionHostId | undefined; setupId: string | undefined } {
  const { projectId, selectionKey, setups } = settingsProject
  const keys = new Set([
    selectionKey,
    projectId,
    ...setups.map((setup) => getCheckoutSelectionKey(projectId, setup.repoId)),
    ...setups.flatMap((setup) =>
      (['repository', 'host', 'folder'] as const).map((mode) => getProjectGroupKey(setup, mode))
    )
  ])
  // Selection records are ordered by the store's last explicit pick, including alias keys.
  for (const key of Object.keys(hostSelection).toReversed()) {
    if (!keys.has(key)) {
      continue
    }
    const hostId = hostSelection[key]
    const setupId = setupSelection[key]
    if (setups.some((setup) => setup.hostId === hostId && (!setupId || setup.id === setupId))) {
      return { hostId, setupId }
    }
  }
  return { hostId: undefined, setupId: undefined }
}

export function getSettingsProjectRemovalScope(
  settingsProject: SettingsProject
): SettingsProjectRemovalScope {
  if (
    settingsProject.selectionKey.includes('::host:') &&
    !settingsProject.selectionKey.includes('::setup:')
  ) {
    return `host:${settingsProject.setups[0]?.hostId ?? ''}`
  }
  if (settingsProject.selectionKey.includes('::setup:')) {
    return 'checkout'
  }
  return 'project'
}

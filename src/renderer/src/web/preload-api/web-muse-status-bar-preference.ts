import type { PreloadApi } from '../../../../preload/api-types'
import type { PairedUiState } from '../../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'

type Updates = Parameters<PreloadApi['ui']['set']>[0]

export function createWebMuseStatusBarPreference() {
  const capableHosts = new Set<string>()
  return {
    read(environmentId: string | undefined, ui: PairedUiState): void {
      if (!environmentId) {
        return
      }
      if (typeof ui._museStatusBarDefaultAdded === 'boolean') {
        capableHosts.add(environmentId)
      } else {
        capableHosts.delete(environmentId)
      }
    },
    prepare(environmentId: string | undefined, updates: Updates): boolean {
      if (environmentId && capableHosts.has(environmentId)) {
        return false
      }
      const stripped =
        updates._museStatusBarDefaultAdded !== undefined ||
        updates.statusBarItems?.includes('muse') === true
      delete updates._museStatusBarDefaultAdded
      if (updates.statusBarItems) {
        updates.statusBarItems = updates.statusBarItems.filter((item) => item !== 'muse')
      }
      return stripped
    },
    assertAcknowledged(stripped: boolean): void {
      if (stripped) {
        throw new Error('Muse status bar preference is pending host support')
      }
    }
  }
}

export function mergeHostMuseStatusBarPreference(
  local: PersistedUIState,
  incoming: PairedUiState
): Pick<PersistedUIState, 'statusBarItems' | '_museStatusBarDefaultAdded'> {
  if (typeof incoming._museStatusBarDefaultAdded === 'boolean') {
    return {
      statusBarItems: incoming.statusBarItems,
      _museStatusBarDefaultAdded: incoming._museStatusBarDefaultAdded
    }
  }
  return {
    statusBarItems: [
      ...(incoming.statusBarItems ?? local.statusBarItems).filter((item) => item !== 'muse'),
      ...(local.statusBarItems.includes('muse') ? ['muse' as const] : [])
    ],
    _museStatusBarDefaultAdded: local._museStatusBarDefaultAdded
  }
}

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { awaitMainProjectCatalogShows, type MainProjectCatalog } from '@/lib/main-project-catalog'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

/** Switch-on, after `target` accepted a catalog write: re-reads a paired server so main sees it. */
async function refreshServerCatalog(target: RuntimeClientTarget): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  // Main re-reads the server's lists, so a server that never announces the write still shows it.
  await window.api.runtime
    .call({
      method: 'sidebarInputs.refreshServerCatalog',
      params: { environmentId: target.environmentId }
    })
    .catch(() => null)
}

/**
 * Switch-on, after `target` accepted a catalog write: resolves true once main's catalog shows it.
 * A catalog that never does is an error the user sees, never a silent success.
 */
export async function mainCatalogShowsWrite(
  target: RuntimeClientTarget,
  shows: (catalog: MainProjectCatalog) => boolean
): Promise<boolean> {
  await refreshServerCatalog(target)
  if (await awaitMainProjectCatalogShows(shows)) {
    return true
  }
  toast.error(
    translate('auto.store.projectCatalog.writeNotShown', 'Could not confirm the change'),
    {
      description: translate(
        'auto.store.projectCatalog.writeNotShownDesc',
        'The host accepted it, but the sidebar has not shown it yet.'
      )
    }
  )
  return false
}

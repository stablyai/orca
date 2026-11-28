import type { RemoteServerUpdateEntry } from '../../../../../../shared/remote-runtime/host-updates/remote-server-update-coordinator'
import type { RemoteServerUpdateSupport } from '../../../../../../shared/remote-runtime/host-catalog/remote-server-update'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { RemoteServerUpdateDialog } from './RemoteServerUpdateDialog'

function manual(name: string, support: RemoteServerUpdateSupport | null): RemoteServerUpdateEntry {
  return {
    environmentId: name,
    name,
    phase: 'manual',
    currentVersion: '1.4.274',
    targetVersion: '1.4.280',
    progress: null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support,
    error: null
  }
}

const entries = [
  manual('linux-orcad', {
    installMode: 'unsupported-headless-serve',
    automatic: false,
    reason: 'updater-unavailable'
  }),
  manual('mac-serve', {
    installMode: 'unsupported-headless-serve',
    automatic: false,
    reason: 'manual-service-update-required'
  }),
  manual('deb-desktop', {
    installMode: 'interactive',
    automatic: false,
    reason: 'manual-service-update-required'
  }),
  manual('dev-checkout', {
    installMode: 'interactive',
    automatic: false,
    reason: 'unpackaged-build'
  }),
  manual('old-server', null)
]

export const manualUpdateReasons = defineFixture({
  width: 640,
  store: {
    remoteServerUpdateDialogOpen: true,
    remoteServerUpdates: new Map(entries.map((entry) => [entry.environmentId, entry])),
    // Opening the dialog refreshes against real servers; keep the fixture's entries.
    refreshRemoteServerUpdates: async () => {}
  },
  render: () => <RemoteServerUpdateDialog />
})

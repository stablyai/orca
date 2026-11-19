import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

function serverEntry(
  environmentId: string,
  name: string,
  currentVersion: string,
  phase: RemoteServerUpdateEntry['phase']
): [string, RemoteServerUpdateEntry] {
  return [
    environmentId,
    {
      environmentId,
      name,
      phase,
      currentVersion,
      targetVersion: '1.4.263',
      progress: null,
      runtimeId: `${environmentId}-runtime`,
      liveTabCount: 2,
      liveLeafCount: 3,
      support: null,
      error: null,
      clientVersion: '1.4.263'
    }
  ]
}

const pairedServers = new Map([
  serverEntry('home-2', 'Mac - Home 2', '1.4.262', 'available'),
  serverEntry('office', 'Mac - Office', '1.4.263', 'current'),
  serverEntry('windows-office', 'Windows - Office', '1.4.263', 'current')
])

export const pairedServersReady = defineFixture({
  width: 720,
  store: {
    updateStatus: { state: 'available', version: '1.4.264', changelog: null },
    remoteServerUpdates: pairedServers
  },
  render: () => <GeneralUpdateSettingsSection />
})

export const pairedServersFollowOff = defineFixture({
  ...pairedServersReady,
  store: {
    ...pairedServersReady.store,
    settings: { ...getDefaultSettings('/home/fixture'), updateRemoteServersWithApp: false }
  }
})

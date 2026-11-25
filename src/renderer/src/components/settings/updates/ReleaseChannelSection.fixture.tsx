import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ReleaseBuild } from '../../../../../shared/updater/release-channel'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { useAppStore } from '../../../store/index'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'
import { ReleaseChannelSection } from './ReleaseChannelSection'

const RUNNING_VERSION = '1.4.272'

function build(version: string, daysAgo: number): ReleaseBuild {
  return {
    tag: `v${version}`,
    version,
    channel: 'stable',
    name: null,
    publishedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    releaseUrl: `https://example.invalid/releases/v${version}`,
    installerUrl: null
  }
}

const BUILDS = [build('1.4.274', 1), build('1.4.273', 2), build(RUNNING_VERSION, 3)]

function stubUpdater(): void {
  // Records switch requests the fixture received, so an interaction check can tell a live click from a dead one.
  const switchRequests: unknown[] = []
  Reflect.set(window, '__releaseSwitchRequests', switchRequests)
  // Lets an interaction check move the status live, as main's broadcasts would.
  Reflect.set(window, '__setFixtureUpdateStatus', (updateStatus: UpdateStatus) =>
    useAppStore.setState({ updateStatus })
  )
  Object.assign(window.api, {
    updater: {
      ...window.api.updater,
      getVersion: async () => RUNNING_VERSION,
      listBuilds: async () => ({ ok: true, builds: BUILDS }),
      check: async (options: unknown) => {
        switchRequests.push(options)
      }
    }
  })
}

function fixtureWith(updateStatus: UpdateStatus) {
  return defineFixture({
    width: 640,
    store: { releaseChannelOverride: null, updateStatus },
    setup: stubUpdater,
    render: () => <ReleaseChannelSection />
  })
}

export const idle = fixtureWith({ state: 'not-available' })

// macOS passed the staging guidance deadline and still owns the update: Switch must not look live.
export const stagingStillRunning = fixtureWith({
  state: 'error',
  failurePhase: 'download',
  version: '1.4.273',
  retryable: false,
  messageCode: 'macStagingTimeout',
  message: 'macOS is still preparing the update. If this persists, quit and reopen Orca.'
})

// Squirrel reported a failure after the deadline; staging is over, so switching works again.
export const stagingFailedLate = fixtureWith({
  state: 'error',
  failurePhase: 'download',
  version: '1.4.273',
  message: 'Could not locate update bundle'
})

// The Settings parent: its Check button plus the Alt-revealed switcher, driven by main's status sequence.
export const settingsParent = defineFixture({
  width: 640,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    releaseChannelOverride: null,
    updateStatus: { state: 'downloading', percent: 100, version: '1.4.273' }
  },
  setup: stubUpdater,
  render: () => <GeneralUpdateSettingsSection />
})

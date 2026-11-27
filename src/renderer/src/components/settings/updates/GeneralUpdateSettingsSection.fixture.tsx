import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import type { ReleaseBuild } from '../../../../../shared/updater/release-channel'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { GeneralSupportStarAction } from '../general/GeneralSupportSection'
import { UpdateCard } from '../../maintenance/update-card/UpdateCard'
import { NotificationCardStack } from '../../notifications/NotificationCardStack'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

const DAY_MS = 24 * 60 * 60 * 1000
const VERSION = '1.4.276'
const NEXT = '1.4.281'
const DEV_VERSION = '1.4.276-adhoc.20261125223543'
/** The settings column at its widest, and at the 600px minimum window beside the 280px sidebar. */
const WIDE = 784
const NARROW = 320

const LONG_ERROR = [
  'Error: net::ERR_CONNECTION_RESET',
  '  at SimpleURLLoader.<anonymous> (node:internal/browser_init:2:114093)',
  '  while GET https://updates.example.test/orca/stable/latest-mac.yml?noCache=1jk2c9xq7 (attempt 3 of 3)',
  'Fallback feed https://mirror-2.example.test/orca/stable/latest-mac.yml returned 503 Service Unavailable'
].join('\n')

const BUILDS: ReleaseBuild[] = [
  ['20261125223543', 'main'],
  ['20261125191204', 'fix/scroll-jank'],
  ['20261124220917', 'feat/split-tabs']
].map(([stamp, name]) => ({
  tag: `v1.4.276-adhoc.${stamp}`,
  version: `1.4.276-adhoc.${stamp}`,
  channel: 'adhoc',
  name: `1.4.276 · ${name}`,
  publishedAt: null,
  releaseUrl: 'https://example.test/release',
  installerUrl: null
}))

function server(
  environmentId: string,
  name: string,
  phase: RemoteServerUpdateEntry['phase'],
  currentVersion: string,
  extra: Partial<RemoteServerUpdateEntry> = {}
): RemoteServerUpdateEntry {
  return {
    environmentId,
    name,
    phase,
    currentVersion,
    targetVersion: phase === 'available' ? NEXT : null,
    progress: null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: null,
    ...extra
  }
}

const SERVERS = new Map(
  [
    server('env-1', 'build-box', 'available', '1.4.270', { liveTabCount: 2, liveLeafCount: 3 }),
    server('env-2', 'gpu-west', 'available', '1.4.268'),
    server('env-3', 'studio-mini', 'manual', '1.4.259'),
    server('env-4', 'lab-runner', 'offline', '1.4.262')
  ].map((entry) => [entry.environmentId, entry])
)

function stubApi(version = VERSION): void {
  Reflect.set(window.api, 'updater', {
    ...window.api.updater,
    getVersion: async () => version,
    listBuilds: async () => ({ ok: true, channel: 'adhoc', builds: BUILDS }),
    check: async () => {},
    download: async () => {},
    quitAndInstall: async () => {}
  })
  Reflect.set(window.api, 'gh', { ...window.api.gh, checkOrcaStarred: async () => false })
}

const nextFrame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120))

/** Opens a fold by its label; the button's text also holds its summary or narrow copy. */
function expand(frame: HTMLElement, label: string): void {
  Array.from(frame.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'))
    .find((button) => button.textContent?.trim().startsWith(label))
    ?.click()
}

function about(
  updateStatus: UpdateStatus,
  options: Partial<ComponentFixture> = {}
): ComponentFixture {
  return defineFixture({
    width: WIDE,
    setup: () => stubApi(),
    store: {
      settings: getDefaultSettings('/home/fixture'),
      updateStatus,
      remoteServerUpdates: SERVERS,
      // Opening the list re-checks; fixtures have no paired runtimes, so keep the seeded rows.
      refreshRemoteServerUpdates: async () => ({ revision: 0 })
    },
    render: () => (
      <div className="settings-view-shell bg-background p-8 text-foreground">
        <GeneralUpdateSettingsSection headerAction={<GeneralSupportStarAction />} />
      </div>
    ),
    ...options
  })
}

const narrow = (fixture: ComponentFixture): ComponentFixture => ({ ...fixture, width: NARROW + 64 })

function withUpdateCard(fixture: ComponentFixture): ComponentFixture {
  return defineFixture({
    ...fixture,
    store: { ...fixture.store, updateCardCollapsed: false, updateReassuranceSeen: true },
    render: () => (
      <>
        {fixture.render()}
        <NotificationCardStack>
          <UpdateCard />
        </NotificationCardStack>
      </>
    )
  })
}

export const upToDate = about({ state: 'not-available' })
export const upToDateNarrow = narrow(upToDate)
export const noServers = defineFixture({
  ...upToDate,
  store: { ...upToDate.store, runtimeEnvironments: [], remoteServerUpdates: new Map() }
})
export const checking = about({ state: 'checking', userInitiated: true })
export const available = about({ state: 'available', version: NEXT, changelog: null })
export const availableNarrow = narrow(available)
export const appUpdateHandoff = withUpdateCard(available)
export const downloading = withUpdateCard(
  about({ state: 'downloading', version: NEXT, percent: 42 })
)
export const downloadingNarrow = narrow(downloading)
export const ready = withUpdateCard(about({ state: 'downloaded', version: NEXT }))
export const readyNarrow = narrow(ready)
export const error = withUpdateCard(
  about({
    state: 'error',
    version: NEXT,
    message: LONG_ERROR,
    userInitiated: true
  })
)
export const errorDetails = defineFixture({
  ...error,
  interact: (frame) => expand(frame, 'Show details')
})
export const errorDetailsNarrow = narrow(errorDetails)
export const heldRelease = about({
  state: 'not-available',
  delayedUpdate: {
    version: NEXT,
    releasedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    availableAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
    delayDays: 7
  }
})

async function revealChannel(frame: HTMLElement): Promise<void> {
  frame
    .querySelector('[data-settings-group-heading]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
  await nextFrame()
  expand(frame, 'Channel')
  await nextFrame()
}

export const channel = about(
  { state: 'not-available' },
  { setup: () => stubApi(DEV_VERSION), interact: revealChannel }
)
export const channelNarrow = narrow(channel)

export const servers = about(
  { state: 'not-available' },
  { interact: (frame) => expand(frame, 'Servers') }
)
export const serversNarrow = narrow(servers)

async function confirmUpdateAll(frame: HTMLElement): Promise<void> {
  Array.from(frame.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Update all')
    ?.click()
  await nextFrame()
}

export const serversConfirm = about({ state: 'not-available' }, { interact: confirmUpdateAll })
export const serversConfirmNarrow = narrow(serversConfirm)

import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import type { ReleaseBuild } from '../../../../../shared/updater/release-channel'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { useAppStore } from '@/store'
import { GeneralSupportStarAction } from '../general/GeneralSupportSection'
import { UpdateCard } from '../../maintenance/update-card/UpdateCard'
import { NotificationCardStack } from '../../notifications/NotificationCardStack'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

const DAY_MS = 24 * 60 * 60 * 1000
const VERSION = '1.4.276'
const NEXT = '1.4.281'
const DEV_VERSION = '1.4.276-adhoc.20261125223543'
/**
 * Frame widths whose About card matches the real app (the frame adds 96px around the card):
 * a 720px card at a 1120px window (the column caps at 784px), and the narrowest 256px card at
 * the 600px minimum window beside the 280px settings sidebar.
 */
const WIDE = 816
const NARROW = 352

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
    server('env-1', 'build-box', 'available', '1.4.270', {
      liveTabCount: 2,
      liveLeafCount: 3
    }),
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
  Reflect.set(window.api, 'gh', {
    ...window.api.gh,
    checkOrcaStarred: async () => false
  })
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

const narrow = (fixture: ComponentFixture): ComponentFixture => ({
  ...fixture,
  width: NARROW
})

function withUpdateCard(fixture: ComponentFixture): ComponentFixture {
  return defineFixture({
    ...fixture,
    store: {
      ...fixture.store,
      updateCardCollapsed: false,
      updateReassuranceSeen: true
    },
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
  store: {
    ...upToDate.store,
    runtimeEnvironments: [],
    remoteServerUpdates: new Map()
  }
})
export const checking = about({ state: 'checking', userInitiated: true })
export const available = about({
  state: 'available',
  version: NEXT,
  changelog: null
})
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

function clickButton(frame: HTMLElement, label: string, index = 0): HTMLButtonElement | undefined {
  const button = Array.from(frame.querySelectorAll<HTMLButtonElement>('button')).filter(
    (candidate) => candidate.textContent?.trim() === label
  )[index]
  button?.focus()
  button?.click()
  return button
}

/** B · Two-step: the first click arms the same button; nothing restarts until a second click. */
async function armUpdateAll(frame: HTMLElement): Promise<void> {
  clickButton(frame, 'Update all')
  await nextFrame()
}

async function armOne(frame: HTMLElement): Promise<void> {
  expand(frame, 'Servers')
  await nextFrame()
  clickButton(frame, 'Update')
  await nextFrame()
}

export const serversArmed = about({ state: 'not-available' }, { interact: armUpdateAll })
export const serversArmedNarrow = narrow(serversArmed)
export const serversArmedOne = about({ state: 'not-available' }, { interact: armOne })
export const serversArmedOneNarrow = narrow(serversArmedOne)

const UPDATING_SERVERS = new Map(
  [
    server('env-1', 'build-box', 'downloading', '1.4.270', {
      targetVersion: NEXT,
      progress: 42
    }),
    server('env-2', 'gpu-west', 'restarting', '1.4.268', {
      targetVersion: NEXT
    }),
    server('env-3', 'edge-01', 'updated', NEXT, { targetVersion: NEXT }),
    server('env-4', 'lab-runner-with-a-very-long-host-name.internal', 'failed', '1.4.262', {
      targetVersion: NEXT,
      error: 'The replacement server did not reconnect within 2 minutes.'
    })
  ].map((entry) => [entry.environmentId, entry])
)

function serversIn(
  entries: Map<string, RemoteServerUpdateEntry>,
  runningNow: boolean
): ComponentFixture {
  const base = about({ state: 'not-available' }, { interact: (frame) => expand(frame, 'Servers') })
  return defineFixture({
    ...base,
    store: {
      ...base.store,
      remoteServerUpdates: entries,
      remoteServerUpdatesRunning: runningNow
    }
  })
}

export const serversUpdating = serversIn(UPDATING_SERVERS, true)
export const serversUpdatingNarrow = narrow(serversUpdating)
export const serversFailed = serversIn(
  new Map(
    [...UPDATING_SERVERS.values()].map((entry) => [
      entry.environmentId,
      entry.phase === 'failed'
        ? entry
        : {
            ...entry,
            phase: 'updated' as const,
            currentVersion: NEXT,
            progress: null
          }
    ])
  ),
  false
)
export const serversFailedNarrow = narrow(serversFailed)
export const serversDone = serversIn(
  new Map(
    [...UPDATING_SERVERS.values()].map((entry) => [
      entry.environmentId,
      {
        ...entry,
        phase: 'updated' as const,
        currentVersion: NEXT,
        progress: null,
        error: null
      }
    ])
  ),
  false
)
export const serversDoneNarrow = narrow(serversDone)

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function patchServer(environmentId: string, patch: Partial<RemoteServerUpdateEntry>): void {
  useAppStore.setState((state) => {
    const current = state.remoteServerUpdates.get(environmentId)
    if (!current) {
      return {}
    }
    const next = new Map(state.remoteServerUpdates)
    next.set(environmentId, { ...current, ...patch })
    return { remoteServerUpdates: next }
  })
}

let flowRuns = 0

/** Fixture-only stand-in for the update run: download %, restart, then done (gpu-west fails once). */
async function simulateUpdates(environmentIds?: readonly string[]): Promise<void> {
  const ids = environmentIds ?? []
  const failOnce = flowRuns === 0
  flowRuns += 1
  useAppStore.setState({ remoteServerUpdatesRunning: true })
  for (const id of ids) {
    patchServer(id, { phase: 'queued', error: null })
  }
  for (const percent of [8, 42, 77, 100]) {
    for (const id of ids) {
      patchServer(id, { phase: 'downloading', progress: percent })
    }
    await wait(700)
  }
  for (const id of ids) {
    patchServer(id, { phase: 'restarting', progress: null })
  }
  await wait(1400)
  for (const id of ids) {
    patchServer(
      id,
      failOnce && id === 'env-2'
        ? { phase: 'failed', error: 'The replacement server did not reconnect within 2 minutes.' }
        : { phase: 'updated', currentVersion: NEXT, targetVersion: NEXT, liveTabCount: 0 }
    )
  }
  useAppStore.setState({ remoteServerUpdatesRunning: false })
}

/** Live flow for interaction checks: arm, confirm, watch rows update, then Retry the failure. */
export const serversFlow = defineFixture({
  ...servers,
  setup: () => {
    flowRuns = 0
    stubApi()
  },
  store: {
    ...servers.store,
    remoteServerUpdates: new Map(
      [
        server('env-1', 'build-box', 'available', '1.4.270', { liveTabCount: 2 }),
        server('env-2', 'gpu-west', 'available', '1.4.268')
      ].map((entry) => [entry.environmentId, entry])
    ),
    startRemoteServerUpdates: simulateUpdates
  }
})
export const serversFlowNarrow = narrow(serversFlow)

export const noServersNarrow = narrow(noServers)
export const checkingNarrow = narrow(checking)
export const errorNarrow = narrow(error)
export const heldReleaseNarrow = narrow(heldRelease)

/** Long hosts that share a prefix lose their middle, not their distinguishing end. */
export const serversSamePrefixNarrow = narrow(
  serversIn(
    new Map(
      [
        server('env-1', 'lab-runner-west-builder-01.internal', 'available', '1.4.270'),
        server('env-2', 'lab-runner-west-builder-02.internal', 'available', '1.4.268')
      ].map((entry) => [entry.environmentId, entry])
    ),
    false
  )
)

import type { PreloadApi } from '../../../preload/api-types'
import type {
  ChangelogData,
  ChangelogRelease,
  ReleaseBuildListResult,
  UpdateCheckOptions,
  UpdateStatus
} from '../../../shared/updater/update-status-types'
import type { ReleaseChannel } from '../../../shared/updater/release-channel'
import { invokeNative, isTauriNativeHost, listenNative } from './tauri-native-host'

type NativeUpdaterStatus =
  | { state: 'idle' }
  | { state: 'checking'; userInitiated: boolean }
  | {
      state: 'available'
      version: string
      changelog: NativeChangelog | null
    }
  | { state: 'not-available'; userInitiated: boolean }
  | { state: 'downloading'; percent: number; version: string }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

type NativeChangelog = {
  release: {
    title: string
    description: string
    releaseNotesUrl: string
  }
  releasesBehind: number | null
}

type NativeUpdaterApi = NonNullable<Partial<PreloadApi>['updater']>

const EVENT_CHECK_FOR_UPDATES_REQUESTED = 'orca:tauri-ui:checkForUpdates'

/** Adapts Tauri's signed updater commands to the shared renderer updater contract. */
export function createTauriNativeUpdaterApi(): NativeUpdaterApi | undefined {
  if (!isTauriNativeHost()) {
    return undefined
  }

  const runCheck = async (options?: UpdateCheckOptions): Promise<void> => {
    await invokeNative<NativeUpdaterStatus>('poc_updater_check', {
      args: {
        userInitiated: options?.localBuild !== true,
        includePrerelease: options?.includePrerelease,
        includePerfPrerelease: options?.includePerfPrerelease,
        channel: options?.channel,
        targetTag: options?.targetTag
      }
    })
  }
  // Why options-shaped: the native menu reads pressed modifiers at click time
  // (Windows `GetAsyncKeyState`) and forwards Electron's hidden modifier-click
  // variants, and the settings picker jumps to exact builds. The signed feed
  // has no channel concept, so Rust resolves those against the GitHub release
  // list and reports availability with the release-page URL; installation of
  // channel builds stays manual.
  listenNative<UpdateCheckOptions | undefined>(EVENT_CHECK_FOR_UPDATES_REQUESTED, (options) => {
    void runCheck(options ?? {})
  })

  return {
    getVersion: () => invokeNative<string>('poc_updater_get_version'),
    getStatus: async () => mapNativeUpdaterStatus(await getNativeStatus()),
    check: runCheck,
    download: async () => {
      await invokeNative<NativeUpdaterStatus>('poc_updater_download')
    },
    quitAndInstall: async () => {
      await invokeNative<void>('poc_updater_quit_and_install')
    },
    dismissNudge: async () => {
      await invokeNative<void>('poc_updater_dismiss_nudge')
    },
    dismissAvailableUpdate: async () => {
      await invokeNative<void>('poc_updater_dismiss_available_update')
    },
    getLinuxPackageInstallInstructions: () =>
      Promise.reject(new Error('Linux package install recovery is not available in Tauri yet.')),
    showLinuxPackage: () =>
      Promise.reject(new Error('Linux package install recovery is not available in Tauri yet.')),
    listBuilds: (channel: ReleaseChannel, options?: { force?: boolean }) =>
      invokeNative<ReleaseBuildListResult>('poc_updater_list_builds', {
        args: { channel, force: options?.force === true }
      }),
    onStatus: (callback) =>
      listenNative<NativeUpdaterStatus>('updater:status', (status) => {
        callback(mapNativeUpdaterStatus(status))
      }),
    onClearDismissal: () => () => {}
  }
}

async function getNativeStatus(): Promise<NativeUpdaterStatus> {
  return invokeNative<NativeUpdaterStatus>('poc_updater_get_status')
}

function mapNativeUpdaterStatus(status: NativeUpdaterStatus): UpdateStatus {
  switch (status.state) {
    case 'idle':
      return { state: 'idle' }
    case 'checking':
      return { state: 'checking', userInitiated: status.userInitiated }
    case 'available':
      return {
        state: 'available',
        version: status.version,
        changelog: mapChangelog(status.changelog)
      }
    case 'not-available':
      return { state: 'not-available', userInitiated: status.userInitiated }
    case 'downloading':
      return { state: 'downloading', percent: status.percent, version: status.version }
    case 'downloaded':
      return { state: 'downloaded', version: status.version }
    case 'error':
      return { state: 'error', message: status.message }
  }
}

function mapChangelog(changelog: NativeChangelog | null): ChangelogData | null {
  if (!changelog) {
    return null
  }
  const release: ChangelogRelease = {
    title: changelog.release.title,
    description: changelog.release.description,
    releaseNotesUrl: changelog.release.releaseNotesUrl
  }
  return { release, releasesBehind: changelog.releasesBehind }
}

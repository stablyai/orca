import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { hydrateOwnerWorktreeVisibilityDefaults } from './worktree-visibility-owner-settings'

export type SettingsStateSetter = Parameters<StateCreator<AppState, [], []>>[0]
type SettingsStateGetter = Parameters<StateCreator<AppState, [], []>>[1]
const completedOwnerVisibilityDefaultsHydration = Promise.resolve()
const ownerVisibilityDefaultsHydrationByStore = new WeakMap<SettingsStateGetter, Promise<void>>()
let settingsPublicationGeneration = 0
let ownerSettingsHydrationGeneration = 0

function mergeOwnerDefaultsIntoCurrentSettings(
  current: GlobalSettings | null,
  hydrated: GlobalSettings
): GlobalSettings {
  if (!current) {
    return hydrated
  }
  const { worktreeVisibilityDefaults } = hydrated
  const { worktreeVisibilityDefaults: _currentDefaults, ...currentWithoutDefaults } = current
  return worktreeVisibilityDefaults
    ? { ...current, worktreeVisibilityDefaults }
    : (currentWithoutDefaults as GlobalSettings)
}

export type FetchSettingsOptions = {
  deferOwnerWorktreeVisibilityDefaults?: boolean
}

export function createSettingsPublicationFence(invalidateOwnerHydration = false): () => boolean {
  const generation = ++settingsPublicationGeneration
  if (invalidateOwnerHydration) {
    ownerSettingsHydrationGeneration += 1
  }
  return () => generation === settingsPublicationGeneration
}

export function createOwnerSettingsHydrationFence(): () => boolean {
  const generation = ++ownerSettingsHydrationGeneration
  return () => generation === ownerSettingsHydrationGeneration
}

export function registerPendingOwnerWorktreeVisibilityDefaultsHydration(
  get: SettingsStateGetter
): (restorePrevious?: boolean) => void {
  const previousHydration = ownerVisibilityDefaultsHydrationByStore.get(get)
  let settle!: () => void
  const hydration = new Promise<void>((resolve) => (settle = resolve))
  ownerVisibilityDefaultsHydrationByStore.set(get, hydration)
  return (restorePrevious = false) => {
    // Why: a fenced local read never reached the point where it superseded the prior owner hydration.
    if (
      restorePrevious &&
      previousHydration &&
      ownerVisibilityDefaultsHydrationByStore.get(get) === hydration
    ) {
      ownerVisibilityDefaultsHydrationByStore.set(get, previousHydration)
    }
    settle()
  }
}

export async function fetchSettingsWithOwnerHydration(args: {
  options?: FetchSettingsOptions
  set: SettingsStateSetter
  get: SettingsStateGetter
}): Promise<void> {
  const shouldPublishSettings = createSettingsPublicationFence()
  const settleOwnerHydration = registerPendingOwnerWorktreeVisibilityDefaultsHydration(args.get)
  let ownerHydrationStarted = false
  try {
    const localSettings = (await window.api.settings.get()) as GlobalSettings
    if (!shouldPublishSettings()) {
      return
    }
    const ownerVisibilityDefaultsHydration = startOwnerWorktreeVisibilityDefaultsHydration({
      settings: localSettings,
      deferPublication: args.options?.deferOwnerWorktreeVisibilityDefaults === true,
      shouldPublish: createOwnerSettingsHydrationFence(),
      set: args.set,
      get: args.get
    })
    ownerHydrationStarted = true
    void ownerVisibilityDefaultsHydration.then(
      () => settleOwnerHydration(),
      () => settleOwnerHydration()
    )
    if (!args.options?.deferOwnerWorktreeVisibilityDefaults) {
      await ownerVisibilityDefaultsHydration
    }
  } catch (err) {
    console.error('Failed to fetch settings:', err)
  } finally {
    if (!ownerHydrationStarted) {
      settleOwnerHydration(true)
    }
  }
}

export function startOwnerWorktreeVisibilityDefaultsHydration(args: {
  settings: GlobalSettings
  deferPublication: boolean
  shouldPublish: () => boolean
  set: SettingsStateSetter
  get: SettingsStateGetter
}): Promise<void> {
  if (args.deferPublication) {
    args.set((state) => ({
      settings: args.settings,
      worktreeVisibilityDefaultsByHost: args.settings.worktreeVisibilityDefaults
        ? {
            ...state.worktreeVisibilityDefaultsByHost,
            [LOCAL_EXECUTION_HOST_ID]: args.settings.worktreeVisibilityDefaults
          }
        : state.worktreeVisibilityDefaultsByHost
    }))
  }
  const settingsAtHydrationStart = args.get().settings
  const hydration = hydrateOwnerWorktreeVisibilityDefaults(
    args.settings,
    args.get().worktreeVisibilityDefaultsByHost
  )
    .then((hydrated) => {
      if (!args.shouldPublish()) {
        return
      }
      args.set((state) => ({
        settings:
          state.settings === settingsAtHydrationStart
            ? hydrated.settings
            : mergeOwnerDefaultsIntoCurrentSettings(state.settings, hydrated.settings),
        worktreeVisibilityDefaultsByHost: {
          ...state.worktreeVisibilityDefaultsByHost,
          ...hydrated.defaultsByHost
        },
        worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId:
          hydrated.supportedRuntimeEnvironmentId,
        worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId:
          hydrated.sourceDefaultsSupportedRuntimeEnvironmentId
      }))
    })
    .catch((err) => console.error('Failed to fetch settings:', err))
  return hydration
}

export function awaitOwnerWorktreeVisibilityDefaultsHydration(
  get: SettingsStateGetter
): Promise<void> {
  return (async () => {
    let hydration =
      ownerVisibilityDefaultsHydrationByStore.get(get) ?? completedOwnerVisibilityDefaultsHydration
    while (true) {
      await hydration
      const latest =
        ownerVisibilityDefaultsHydrationByStore.get(get) ??
        completedOwnerVisibilityDefaultsHydration
      if (latest === hydration) {
        return
      }
      hydration = latest
    }
  })()
}

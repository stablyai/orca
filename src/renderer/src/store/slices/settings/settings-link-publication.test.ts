import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type * as OwnerSettingsModule from './worktree-visibility-owner-settings'

const hydration = vi.hoisted((): { gate: Promise<void> | null } => ({ gate: null }))
vi.mock('./worktree-visibility-owner-settings', async (importOriginal) => {
  const original = await importOriginal<typeof OwnerSettingsModule>()
  return {
    ...original,
    hydrateOwnerWorktreeVisibilityDefaults: async (
      ...args: Parameters<typeof original.hydrateOwnerWorktreeVisibilityDefaults>
    ) => {
      await hydration.gate
      return original.hydrateOwnerWorktreeVisibilityDefaults(...args)
    }
  }
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const base = (): GlobalSettings => ({
  ...getDefaultSettings('/home/test'),
  httpLinkClickBehavior: 'ask'
})
const links = () => {
  const settings = useAppStore.getState().settings
  return {
    openLinksInApp: settings?.openLinksInApp,
    httpLinkClickBehavior: settings?.httpLinkClickBehavior
  }
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
let api: ReturnType<typeof createStoreCascadesMockApi>

beforeEach(() => {
  hydration.gate = null
  api = createStoreCascadesMockApi()
  useAppStore.setState({ settings: base() })
})

describe('link fields from main replies', () => {
  it('keep an accepted link write even when a later unrelated write fails', async () => {
    const accepted = deferred<GlobalSettings>()
    api.settings.set
      .mockImplementationOnce(() => accepted.promise)
      .mockRejectedValueOnce(new Error('rejected'))
    const remember = useAppStore
      .getState()
      .updateSettingsOrThrow({ openLinksInApp: true, httpLinkClickBehavior: 'open' })
    const unrelated = useAppStore.getState().updateSettingsOrThrow({ theme: 'dark' })
    await expect(unrelated).rejects.toThrow('rejected')
    accepted.resolve({ ...base(), openLinksInApp: true, httpLinkClickBehavior: 'open' })
    await remember
    expect(links()).toEqual({ openLinksInApp: true, httpLinkClickBehavior: 'open' })
  })

  it('survive a settings read whose publication waited on owner hydration', async () => {
    const gate = deferred<void>()
    hydration.gate = gate.promise
    api.settings.get.mockResolvedValueOnce(base())
    const fetching = useAppStore.getState().fetchSettings()
    await settle()
    const accepted = deferred<GlobalSettings>()
    api.settings.set
      .mockImplementationOnce(() => accepted.promise)
      .mockRejectedValueOnce(new Error('rejected'))
    const remember = useAppStore
      .getState()
      .updateSettingsOrThrow({ openLinksInApp: true, httpLinkClickBehavior: 'open' })
    // A later failing write leaves the link write's own publication suppressed.
    await expect(useAppStore.getState().updateSettingsOrThrow({ theme: 'dark' })).rejects.toThrow()
    accepted.resolve({ ...base(), openLinksInApp: true, httpLinkClickBehavior: 'open' })
    await remember
    gate.resolve()
    await fetching
    expect(links()).toEqual({ openLinksInApp: true, httpLinkClickBehavior: 'open' })
  })
})

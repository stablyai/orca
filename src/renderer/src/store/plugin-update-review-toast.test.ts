// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginAutoUpdateEvent } from '../../../preload/api-types'
import type { PluginUpdateReviewNotice } from '../../../shared/plugins/catalog/plugin-update-policy'
import { isProtectedPluginTranslationPath } from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import en from '../i18n/locales/en.json'

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn() }),
  requestPluginUpdateReview: vi.fn()
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('./plugin-preview-request', () => ({
  requestPluginUpdateReview: mocks.requestPluginUpdateReview
}))

type WarningOptions = {
  description: string
  onDismiss: () => void
  action: { label: string; onClick: () => void }
  cancel: { label: string; onClick: () => void }
}

function notice(
  pluginKey: string,
  overrides: Partial<PluginUpdateReviewNotice> = {}
): PluginUpdateReviewNotice {
  return {
    pluginKey,
    name: 'Demo',
    publisher: 'octo',
    version: '2.0.0',
    reason: 'access',
    ...overrides
  }
}

function lastWarning(): { title: string; options: WarningOptions } {
  const call = mocks.toast.warning.mock.calls.at(-1)
  if (!call) {
    throw new Error('no warning toast')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the module under test passes these options.
  return { title: call[0] as string, options: call[1] as WarningOptions }
}

async function loadToast() {
  vi.resetModules()
  return import('./plugin-update-review-toast')
}

beforeEach(() => {
  mocks.toast.warning.mockReset()
  mocks.toast.success.mockReset()
  mocks.requestPluginUpdateReview.mockReset()
})

describe('announcePluginUpdateReviews', () => {
  it('names one held update, its Orca-derived publisher, and only opens its review', async () => {
    const { announcePluginUpdateReviews } = await loadToast()
    announcePluginUpdateReviews([notice('octo.demo')])
    const { title, options } = lastWarning()
    expect(title).toBe('Demo 2.0.0 wants more access')
    expect(options.description).toBe('Published by octo. It won’t update until you review it.')
    options.action.onClick()
    expect(mocks.requestPluginUpdateReview).toHaveBeenCalledWith({ pluginKey: 'octo.demo' })
  })

  it('says a moved repository plainly instead of claiming more access', async () => {
    const { announcePluginUpdateReviews } = await loadToast()
    announcePluginUpdateReviews([notice('octo.demo', { reason: 'repository' })])
    expect(lastWarning().title).toBe('Demo 2.0.0 comes from a different repository')
  })

  it('groups several into one toast that opens the Updates list', async () => {
    const { announcePluginUpdateReviews } = await loadToast()
    announcePluginUpdateReviews([notice('octo.a'), notice('octo.b'), notice('octo.c')])
    expect(mocks.toast.warning).toHaveBeenCalledTimes(1)
    const { title, options } = lastWarning()
    expect(title).toBe('3 plugin updates need your review')
    options.action.onClick()
    expect(mocks.requestPluginUpdateReview).toHaveBeenCalledWith({ pluginKey: null })
  })

  it('folds a later batch into the open toast, and starts fresh once dismissed', async () => {
    const { announcePluginUpdateReviews } = await loadToast()
    announcePluginUpdateReviews([notice('octo.a')])
    announcePluginUpdateReviews([notice('octo.b')])
    expect(lastWarning().title).toBe('2 plugin updates need your review')
    lastWarning().options.cancel.onClick()
    announcePluginUpdateReviews([notice('octo.c', { name: 'Third' })])
    expect(lastWarning().title).toBe('Third 2.0.0 wants more access')
  })

  it('shows nothing for no notices and never approves on dismiss', async () => {
    const { announcePluginUpdateReviews } = await loadToast()
    announcePluginUpdateReviews([])
    expect(mocks.toast.warning).not.toHaveBeenCalled()
    announcePluginUpdateReviews([notice('octo.demo')])
    lastWarning().options.cancel.onClick()
    expect(mocks.requestPluginUpdateReview).not.toHaveBeenCalled()
  })
})

describe('held-update toast copy', () => {
  it('is protected from language packs, so a pack cannot soften the warning', () => {
    const keys = Object.keys(en.auto.components.settings.PluginUpdateReviewToast)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(
        isProtectedPluginTranslationPath(`auto.components.settings.PluginUpdateReviewToast.${key}`)
      ).toBe(true)
    }
  })
})

describe('ensurePluginAutoUpdatesWatched', () => {
  let listener: ((event: PluginAutoUpdateEvent) => void) | null = null
  const take = vi.fn<() => Promise<PluginUpdateReviewNotice[]>>()

  beforeEach(() => {
    listener = null
    take.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        plugins: {
          getAutoUpdateState: vi.fn().mockResolvedValue({ updated: {}, needsReview: {} }),
          onAutoUpdateChanged: (callback: (event: PluginAutoUpdateEvent) => void) => {
            listener = callback
            return () => undefined
          },
          takeUpdateReviewNotices: take
        }
      }
    })
  })
  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  it('shows untold holds on start, as when a window opens after a pass', async () => {
    take.mockResolvedValueOnce([notice('octo.demo')])
    vi.resetModules()
    const { ensurePluginAutoUpdatesWatched } = await import('./plugin-auto-updates')
    ensurePluginAutoUpdatesWatched()
    await vi.waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
  })

  it('shows no review toast for an update that installed on its own', async () => {
    take.mockResolvedValue([])
    vi.resetModules()
    const { ensurePluginAutoUpdatesWatched } = await import('./plugin-auto-updates')
    ensurePluginAutoUpdatesWatched()
    await vi.waitFor(() => expect(take).toHaveBeenCalledTimes(1))
    listener?.({
      state: { updated: { 'octo.demo': '1.1.0' }, needsReview: {} },
      updated: [{ pluginKey: 'octo.demo', name: 'Demo', version: '1.1.0' }]
    })
    await vi.waitFor(() => expect(take).toHaveBeenCalledTimes(2))
    expect(mocks.toast.success).toHaveBeenCalledWith('Demo updated to 1.1.0')
    expect(mocks.toast.warning).not.toHaveBeenCalled()
  })
})

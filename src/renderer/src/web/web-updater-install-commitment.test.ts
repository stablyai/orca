// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { isUpdaterInstallCommitted } from '../lib/updater-install-commitment'
import { installWebPreloadApi } from './web-preload-api'

describe('web build updater install commitment', () => {
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('never reports an install, so chunk recovery stays enabled', () => {
    // The web build serves chunks over HTTP from a running server; no installer ever
    // swaps an archive underneath it. Reporting true here would disable ordinary
    // lazy-chunk recovery for every web user.
    installWebPreloadApi()

    expect(
      (window as unknown as { api: { updater: { isInstallCommittedNow: () => boolean } } }).api
        .updater.isInstallCommittedNow()
    ).toBe(false)
    // Exercised through the same accessor chunk recovery uses.
    expect(isUpdaterInstallCommitted()).toBe(false)
  })
})

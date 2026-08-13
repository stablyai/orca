// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { isUpdaterInstallCommitted } from './updater-install-commitment'

/** Stands in for preload's buffered value, which is a live read rather than a snapshot. */
function installBridge(value: boolean | 'absent'): void {
  ;(window as unknown as { api: unknown }).api =
    value === 'absent' ? {} : { updater: { isInstallCommittedNow: () => value } }
}

describe('renderer updater install commitment', () => {
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('reports main’s view with no registration or effect involved', () => {
    // The load-bearing case: a document created or reloaded mid-install whose React
    // effects have not run. Correctness must not depend on anything mounting.
    installBridge(true)

    expect(isUpdaterInstallCommitted()).toBe(true)
  })

  it('is a live read, so a commitment landing later is visible immediately', () => {
    let committed = false
    ;(window as unknown as { api: unknown }).api = {
      updater: { isInstallCommittedNow: () => committed }
    }
    expect(isUpdaterInstallCommitted()).toBe(false)

    committed = true

    expect(isUpdaterInstallCommitted()).toBe(true)
  })

  it('stands down as soon as main does, with no local state to strand', () => {
    let committed = true
    ;(window as unknown as { api: unknown }).api = {
      updater: { isInstallCommittedNow: () => committed }
    }

    committed = false

    expect(isUpdaterInstallCommitted()).toBe(false)
  })

  it('keeps chunk recovery enabled where no bridge exists', () => {
    installBridge('absent')

    expect(isUpdaterInstallCommitted()).toBe(false)
  })

  it('treats a bridge that throws as no install, rather than breaking the load', () => {
    ;(window as unknown as { api: unknown }).api = {
      updater: {
        isInstallCommittedNow: () => {
          throw new Error('bridge is gone')
        }
      }
    }

    expect(isUpdaterInstallCommitted()).toBe(false)
  })
})

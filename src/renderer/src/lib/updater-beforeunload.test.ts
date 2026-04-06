import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isUpdaterQuitAndInstallInProgress,
  registerUpdaterBeforeUnloadBypass
} from './updater-beforeunload'
import {
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../shared/updater-renderer-events'

type WindowEventStub = Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>

beforeEach(() => {
  const eventTarget = new EventTarget()
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget)
  } satisfies WindowEventStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('registerUpdaterBeforeUnloadBypass', () => {
  it('tracks updater quit-and-install lifecycle events', () => {
    const cleanup = registerUpdaterBeforeUnloadBypass()
    expect(isUpdaterQuitAndInstallInProgress()).toBe(false)

    window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT))
    expect(isUpdaterQuitAndInstallInProgress()).toBe(true)

    window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT))
    expect(isUpdaterQuitAndInstallInProgress()).toBe(false)

    cleanup()
  })

  it('resets the bypass flag during cleanup', () => {
    const cleanup = registerUpdaterBeforeUnloadBypass()

    window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT))
    expect(isUpdaterQuitAndInstallInProgress()).toBe(true)

    cleanup()
    expect(isUpdaterQuitAndInstallInProgress()).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_PROJECT_NOTES_REQUEST_CLOSE_EVENT,
  requestProjectNotesTabClose,
  type ProjectNotesCloseRequestDetail
} from './project-notes-close-request'

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

describe('requestProjectNotesTabClose', () => {
  it('dispatches a close request and lets a mounted notes tab claim it', () => {
    const close = vi.fn()
    const listener = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<ProjectNotesCloseRequestDetail>).detail
      detail.claim()
      expect(detail.tabId).toBe('tab-1')
      expect(detail.close).toBe(close)
    })
    window.addEventListener(ORCA_PROJECT_NOTES_REQUEST_CLOSE_EVENT, listener)
    try {
      requestProjectNotesTabClose('tab-1', close)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(ORCA_PROJECT_NOTES_REQUEST_CLOSE_EVENT, listener)
    }
  })

  it('closes immediately when no notes tab claims the request', () => {
    const close = vi.fn()
    requestProjectNotesTabClose('tab-1', close)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

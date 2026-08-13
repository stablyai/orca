// @vitest-environment happy-dom

// #10590 follow-up: GeneralUpdateSettingsSection renders GeneralRemoteServerUpdates inside the
// same <section>, so both hints are on screen together. They must be distinct copy — the app
// button can install a local macOS build, the paired-server button provably cannot
// (refreshRemoteServerUpdates forwards only the prerelease flags).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRemoteServerUpdateCheckHint,
  getUpdateCheckHint
} from '@/lib/update-check-click-options'

const storeState = {
  settingsSearchQuery: '',
  updateStatus: { state: 'idle' as const },
  remoteServerUpdates: new Map([
    ['server-a', { environmentId: 'server-a', name: 'Test server A', phase: 'current' }]
  ]),
  remoteServerUpdatesChecking: false,
  remoteServerUpdatesRunning: false,
  refreshRemoteServerUpdates: vi.fn(),
  setRemoteServerUpdateDialogOpen: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('./ReleaseChannelSection', () => ({ ReleaseChannelSection: () => null }))

import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // Minimal preload surface: only what these components reach for.
  window.api = {
    updater: { getVersion: () => Promise.resolve('1.4.155'), check: vi.fn() }
  } as unknown as typeof window.api
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('#10590 update hint across the app and remote-server surfaces', () => {
  it('does not repeat one sentence on both buttons', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<GeneralUpdateSettingsSection />))

    const text = container.textContent ?? ''
    expect(text).toContain(getUpdateCheckHint())
    expect(text).toContain(getRemoteServerUpdateCheckHint())
    expect(countOccurrences(text, getUpdateCheckHint())).toBe(1)
    expect(countOccurrences(text, getRemoteServerUpdateCheckHint())).toBe(1)
  })

  it('never promises a local macOS build on a paired server', () => {
    for (const isMac of [true, false]) {
      expect(getRemoteServerUpdateCheckHint(isMac)).not.toMatch(/macOS/)
      expect(getRemoteServerUpdateCheckHint(isMac)).not.toContain('⌥')
      expect(getRemoteServerUpdateCheckHint(isMac)).not.toBe(getUpdateCheckHint(isMac))
    }
  })
})

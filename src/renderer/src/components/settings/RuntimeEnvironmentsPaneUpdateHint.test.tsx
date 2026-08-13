// @vitest-environment happy-dom

// #10590: RuntimeEnvironmentsPane is the third surface carrying the paired-server update check.
// It had no render harness, so nothing proved its hint is wired to the button or that it stays
// off the screen when there is no button to describe.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { getRemoteServerUpdateCheckHint } from '@/lib/update-check-click-options'

const { useAppStore } = vi.hoisted(() => {
  const storeState = {
    settingsSearchQuery: '',
    remoteServerUpdates: new Map(),
    remoteServerUpdatesChecking: false,
    remoteServerUpdatesRunning: false,
    refreshRemoteServerUpdates: vi.fn(),
    setRemoteServerUpdateDialogOpen: vi.fn(),
    setRuntimeEnvironments: vi.fn(),
    setRuntimeEnvironmentStatus: vi.fn(),
    runtimeEnvironmentStatuses: {}
  }
  return {
    useAppStore: Object.assign(
      (selector: (state: typeof storeState) => unknown) => selector(storeState),
      { getState: () => storeState }
    )
  }
})

vi.mock('@/store', () => ({ useAppStore }))
vi.mock('../../store', () => ({ useAppStore }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('./RuntimePairingUrlGenerator', () => ({ RuntimePairingUrlGenerator: () => null }))
vi.mock('./EphemeralVmRuntimesSection', () => ({ EphemeralVmRuntimesSection: () => null }))
vi.mock('./CloudVmSetupGuide', () => ({ CloudVmSetupGuide: () => null }))
vi.mock('./RuntimeHostAccessForm', () => ({ RuntimeHostAccessForm: () => null }))
vi.mock('./RemoteServerUpdateStatus', () => ({
  RemoteServerUpdateStatus: () => null,
  getRemoteServerManualUpdateHelp: () => ''
}))

import { RuntimeEnvironmentsPane } from './RuntimeEnvironmentsPane'

let root: Root | null = null
let container: HTMLDivElement | null = null
type EnvironmentFixture = {
  id: string
  name: string
  source: string
  endpoints: { endpoint: string }[]
}

let savedEnvironments: EnvironmentFixture[] = []

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  savedEnvironments = [
    {
      id: 'server-a',
      name: 'Test server A',
      source: 'user',
      endpoints: [{ endpoint: 'https://server-a.example:7777' }]
    }
  ]
  // Minimal preload surface: only what this pane reaches for during a plain render.
  window.api = {
    runtimeEnvironments: {
      list: () => Promise.resolve(savedEnvironments),
      getStatus: () => Promise.resolve({ ok: false, error: 'offline' })
    }
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

async function renderPane(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <RuntimeEnvironmentsPane
        settings={{ activeRuntimeEnvironmentId: null } as unknown as GlobalSettings}
        setActiveRuntimeEnvironmentPreference={() => Promise.resolve(true)}
      />
    )
  })
  return container
}

function findUpdateCheckButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-describedby') === expectedHintId
  )
}

const expectedHintId = 'runtime-environments-update-check-hint'

describe('#10590 RuntimeEnvironmentsPane update-channel hint', () => {
  it('describes the paired-server check button with the visible hint', async () => {
    const host = await renderPane()
    const button = findUpdateCheckButton(host)

    expect(button).toBeDefined()
    const hint = host.querySelector(`#${expectedHintId}`)
    expect(hint?.textContent).toBe(getRemoteServerUpdateCheckHint())
  })

  it('never promises a local macOS build on a paired server', async () => {
    const host = await renderPane()
    const hint = host.querySelector(`#${expectedHintId}`)

    // A paired server is usually Linux/SSH, and refreshRemoteServerUpdates drops localBuild.
    expect(hint?.textContent).not.toMatch(/macOS/)
    expect(hint?.textContent).not.toContain('⌥')
    expect(hint?.textContent).toContain('checks servers for the latest RC')
  })

  it('omits the hint when no paired server exists, so it describes nothing', async () => {
    savedEnvironments = []
    const host = await renderPane()

    expect(host.querySelector(`#${expectedHintId}`)).toBeNull()
    expect(findUpdateCheckButton(host)).toBeUndefined()
  })
})

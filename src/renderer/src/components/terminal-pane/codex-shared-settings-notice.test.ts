// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCodexSharedSettingsNotice } from './codex-shared-settings-notice'

// Why a real zustand store double: the hook relies on subscribe/setState semantics.
const { toastInfoMock, harness } = vi.hoisted(() => ({
  toastInfoMock: vi.fn(),
  harness: { setState: (_patch: Record<string, unknown>, _replace?: true): void => {} }
}))

vi.mock('sonner', () => ({ toast: { info: toastInfoMock } }))

vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  const { createStore } = await import('zustand/vanilla')
  const backing = createStore<Record<string, unknown>>()(() => ({}))
  harness.setState = (patch, replace) =>
    replace ? backing.setState(patch, true) : backing.setState(patch)
  // Why reactive: the hook re-runs when the seen flag changes.
  const useAppStore = <T>(selector: (state: Record<string, unknown>) => T): T =>
    useStore(backing, selector)
  return { useAppStore: Object.assign(useAppStore, backing) }
})

const store = {
  setState: (patch: Record<string, unknown>, replace?: true) => harness.setState(patch, replace)
}
const codexTab = { 'wt-1': [{ id: 'tab-1', launchAgent: 'codex' }] }
const mountedRoots: Root[] = []
let seen = false

function resetStore(overrides: Record<string, unknown> = {}): void {
  seen = false
  store.setState(
    {
      codexSharedSettingsNoticeSeen: false,
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      markCodexSharedSettingsNoticeSeen: () => {
        seen = true
        store.setState({ codexSharedSettingsNoticeSeen: true })
      },
      ...overrides
    },
    true
  )
}

function HookProbe(): null {
  useCodexSharedSettingsNotice()
  return null
}

async function mountProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe))
  })
}

describe('useCodexSharedSettingsNotice', () => {
  beforeEach(() => {
    toastInfoMock.mockReset()
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    resetStore()
  })

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount())
    }
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('shows once on Windows when a Codex terminal appears, and marks it seen', async () => {
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()

    await act(async () => store.setState({ tabsByWorktree: codexTab }))
    await act(async () =>
      store.setState({ agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } })
    )

    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    const [title, options] = toastInfoMock.mock.calls[0] ?? []
    expect(title).toBe('Codex in Orca now shares your Codex settings')
    expect(options).toMatchObject({ id: 'codex-shared-settings-notice', duration: 15_000 })
    expect(options?.description).toContain('~/.codex')
    expect(options?.action).toBeUndefined()
    expect(seen).toBe(true)
  })

  it('stays quiet off Windows', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    resetStore({ tabsByWorktree: codexTab })
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()
    expect(seen).toBe(false)
  })

  it('stays quiet in a paired web client window', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    resetStore({ tabsByWorktree: codexTab })
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('shows when the seen flag clears with a Codex terminal already open', async () => {
    resetStore({ codexSharedSettingsNoticeSeen: true, tabsByWorktree: codexTab })
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()

    await act(async () => store.setState({ codexSharedSettingsNoticeSeen: false }))
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
  })
})

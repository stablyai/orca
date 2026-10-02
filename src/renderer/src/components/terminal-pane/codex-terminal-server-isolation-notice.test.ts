// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { useCodexTerminalServerIsolationNotice } from './codex-terminal-server-isolation-notice'

// Why a real zustand store double: the hook relies on subscribe/setState semantics.
const { toastInfoMock, harness } = vi.hoisted(() => ({
  toastInfoMock: vi.fn(),
  harness: { setState: (_patch: Record<string, unknown>, _replace?: true): void => {} }
}))

vi.mock('sonner', () => ({ toast: { info: toastInfoMock } }))

vi.mock('@/store', async () => {
  const { createStore } = await import('zustand/vanilla')
  const backing = createStore<Record<string, unknown>>()(() => ({}))
  harness.setState = (patch, replace) =>
    replace ? backing.setState(patch, true) : backing.setState(patch)
  const useAppStore = <T>(selector: (state: Record<string, unknown>) => T): T =>
    selector(backing.getState())
  return { useAppStore: Object.assign(useAppStore, backing) }
})

const store = {
  setState: (patch: Record<string, unknown>, replace?: true) => harness.setState(patch, replace)
}
let seen = false

const openSettingsPage = vi.fn()
const openSettingsTarget = vi.fn()
const mountedRoots: Root[] = []

function resetStore(overrides: Record<string, unknown> = {}): void {
  seen = false
  store.setState(
    {
      persistedUIReady: true,
      codexTerminalServerIsolationNoticeSeen: false,
      settings: { codexTerminalServerIsolation: true },
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      openSettingsPage,
      openSettingsTarget,
      markCodexTerminalServerIsolationNoticeSeen: () => {
        seen = true
        store.setState({ codexTerminalServerIsolationNoticeSeen: true })
      },
      ...overrides
    },
    true
  )
}

function HookProbe(): null {
  useCodexTerminalServerIsolationNotice()
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

const codexTab = { 'wt-1': [{ id: 'tab-1', launchAgent: 'codex' }] }

describe('useCodexTerminalServerIsolationNotice', () => {
  beforeEach(() => {
    toastInfoMock.mockReset()
    openSettingsPage.mockReset()
    openSettingsTarget.mockReset()
    resetStore()
  })

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount())
    }
    document.body.innerHTML = ''
  })

  it('shows once when the first Codex terminal starts, and marks it seen', async () => {
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()

    act(() => store.setState({ tabsByWorktree: codexTab }))
    act(() => store.setState({ agentStatusByPaneKey: { 'tab-2:leaf': { agentType: 'codex' } } }))

    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(toastInfoMock.mock.calls[0]?.[1]).toMatchObject({ duration: Infinity })
    expect(seen).toBe(true)
  })

  it.each([
    [
      'a typed codex seen by hooks',
      { agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } }
    ],
    [
      'a typed codex in the foreground',
      { paneForegroundAgentByPaneKey: { 'tab-1:leaf': { agent: 'codex' } } }
    ]
  ])('also triggers on %s', async (_name, patch) => {
    await mountProbe()
    act(() => store.setState(patch))
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
  })

  it('never shows for other agents', async () => {
    await mountProbe()
    act(() =>
      store.setState({
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', launchAgent: 'claude' }] },
        agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'claude' } },
        paneForegroundAgentByPaneKey: { 'tab-1:leaf': { agent: 'opencode' } }
      })
    )
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it.each([
    ['it was already seen', { codexTerminalServerIsolationNoticeSeen: true }],
    ['the user turned the setting off', { settings: { codexTerminalServerIsolation: false } }],
    ['persisted UI has not hydrated', { persistedUIReady: false }]
  ])('stays quiet when %s', async (_name, overrides) => {
    resetStore({ ...overrides, tabsByWorktree: codexTab })
    await mountProbe()
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('opens Settings at the Codex server setting', async () => {
    resetStore({ tabsByWorktree: codexTab })
    await mountProbe()

    toastInfoMock.mock.calls[0]?.[1]?.action.onClick()

    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'agents',
      repoId: null,
      sectionId: CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID
    })
  })
})

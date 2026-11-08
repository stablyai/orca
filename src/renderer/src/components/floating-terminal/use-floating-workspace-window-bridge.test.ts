// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { startFloatingWorkspaceWindowBridge } from './use-floating-workspace-window-bridge'

const initialAppState = useAppStore.getInitialState()
const popoutSettings = {
  ...getDefaultSettings('/test'),
  floatingTerminalEnabled: true,
  experimentalFloatingWorkspacePopout: true,
  experimentalFloatingWorkspaceMode: 'popout' as const
}

function stubWindowApi() {
  const handlers = new Map<string, () => void>()
  const on = (name: string) => (callback: () => void) => {
    handlers.set(name, callback)
    return () => handlers.delete(name)
  }
  const api = {
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    publishSnapshot: vi.fn(),
    onSnapshotRequested: on('snapshotRequested'),
    onDockRequested: on('dock'),
    onHiddenByUser: on('hiddenByUser'),
    onAgentAcked: on('agentAcked')
  }
  vi.stubGlobal('api', { floatingWorkspaceWindow: api, dashboard: {} })
  return { api, handlers }
}

beforeEach(() => {
  useAppStore.setState({
    ...initialAppState,
    settings: popoutSettings,
    floatingWorkspacePanelOpen: true,
    updateSettings: vi.fn(async (updates: Partial<GlobalSettings>) => {
      useAppStore.setState((s) => ({ settings: { ...popoutSettings, ...s.settings, ...updates } }))
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppState, true)
})

describe('Floating Workspace window bridge', () => {
  it('dock opens the in-window panel and requests destroy only after the in-window pane has fit', async () => {
    const { api, handlers } = stubWindowApi()
    useAppStore.setState({ floatingWorkspacePanelOpen: false })
    let paneFit: () => void = () => undefined
    const stop = startFloatingWorkspaceWindowBridge(
      () => new Promise((resolve) => (paneFit = resolve))
    )
    useAppStore.setState({ floatingWorkspacePanelOpen: true })
    expect(api.show).toHaveBeenCalledWith({ focus: true })

    handlers.get('dock')?.()
    await vi.waitFor(() => expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(true))
    await vi.waitFor(() =>
      expect(useAppStore.getState().settings?.experimentalFloatingWorkspaceMode).toBe('in-window')
    )
    expect(api.destroy).not.toHaveBeenCalled()
    paneFit()
    await vi.waitFor(() => expect(api.destroy).toHaveBeenCalledTimes(1))
    stop()
  })

  it('returning to Pop-out during the dock fit wait keeps the reshown window', async () => {
    const { api, handlers } = stubWindowApi()
    let paneFit: () => void = () => undefined
    let fit: Promise<void> = Promise.resolve()
    const stop = startFloatingWorkspaceWindowBridge(
      () => (fit = new Promise((resolve) => (paneFit = resolve)))
    )
    handlers.get('dock')?.()
    await vi.waitFor(() =>
      expect(useAppStore.getState().settings?.experimentalFloatingWorkspaceMode).toBe('in-window')
    )
    await useAppStore.getState().updateSettings({ experimentalFloatingWorkspaceMode: 'popout' })
    expect(api.show).toHaveBeenCalledTimes(2)
    paneFit()
    await fit
    expect(api.destroy).not.toHaveBeenCalled()
    stop()
  })

  it('leaving Pop-out while the window is hidden destroys it without opening the panel', async () => {
    const { api, handlers } = stubWindowApi()
    const waitForFit = vi.fn(async () => undefined)
    const stop = startFloatingWorkspaceWindowBridge(waitForFit)
    handlers.get('hiddenByUser')?.()
    handlers.get('dock')?.()
    await vi.waitFor(() => expect(api.destroy).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(false)
    expect(waitForFit).not.toHaveBeenCalled()
    stop()
  })

  it('a bridge that starts in-window destroys a window a crashed renderer left mid-dock', async () => {
    const { api } = stubWindowApi()
    useAppStore.setState({
      settings: { ...popoutSettings, experimentalFloatingWorkspaceMode: 'in-window' }
    })
    const stop = startFloatingWorkspaceWindowBridge()
    await vi.waitFor(() => expect(api.destroy).toHaveBeenCalledTimes(1))
    expect(api.show).not.toHaveBeenCalled()
    stop()
  })

  it('a user hide closes the open flag without hiding the window a second time', () => {
    const { api, handlers } = stubWindowApi()
    const stop = startFloatingWorkspaceWindowBridge()
    expect(api.show).toHaveBeenCalledWith({ focus: false })
    handlers.get('hiddenByUser')?.()
    expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(false)
    expect(api.hide).not.toHaveBeenCalled()
    stop()
  })
})

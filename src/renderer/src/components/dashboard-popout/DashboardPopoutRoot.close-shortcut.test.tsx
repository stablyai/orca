// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { KeybindingFileSnapshot } from '../../../../shared/keybindings'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

const platform = vi.hoisted(() => ({ value: 'darwin' }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => platform.value }))
vi.mock('@/hooks/useAppMenuPaste', () => ({ useAppMenuPaste: () => {} }))
vi.mock('@/hooks/useAppMenuSelectionActions', () => ({ useAppMenuSelectionActions: () => {} }))
vi.mock('./use-agent-dashboard-telemetry', () => ({ useAgentDashboardTelemetry: () => {} }))
vi.mock('./AgentKanbanBoard', () => ({ AgentKanbanBoard: () => null }))
vi.mock('./useDashboardSnapshot', () => ({ useDashboardSnapshot: () => null }))
vi.mock('@/lib/react-devtools-commit-hook-shim', () => ({}))
vi.mock('@/lib/react-commit-cascade-observer', () => ({}))
vi.mock('@/lib/crash-diagnostics', () => ({
  installRendererCrashDiagnostics: () => {},
  recordRendererCrashBreadcrumb: () => {}
}))
vi.mock('@/lib/react-commit-cascade-telemetry', () => ({
  setReactCommitCascadeRendererSurface: () => {}
}))
vi.mock('@/lib/os-file-drop-cancellation-guard', () => ({
  installOsFileDropCancellationGuard: () => () => {}
}))
vi.mock('@/lib/body-overlay-attributes', () => ({ installBodyOverlayAttributes: () => () => {} }))
vi.mock('@/i18n/I18nProvider', () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@/lib/react-renderer-root', () => ({
  getOrCreateRendererRoot: () => ({ render: (node: ReactNode) => render(node) })
}))

import { DashboardPopoutRoot } from './DashboardPopoutRoot'

describe('dashboard pop-out close shortcut', () => {
  const initialKeybindings = useAppStore.getState().keybindings

  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    useAppStore.setState({ keybindings: initialKeybindings })
  })

  it('uses binding broadcasts while open and releases the subscription on unmount', async () => {
    const initial = useAppStore.getState()
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
    const originalAttributes = new Map(
      [...document.documentElement.attributes].map(({ name, value }) => [name, value])
    )
    const listeners = new Set<(snapshot: KeybindingFileSnapshot) => void>()
    const subscribed: ((snapshot: KeybindingFileSnapshot) => void)[] = []
    const settings = createGlobalSettingsFixture({ theme: 'dark' })
    const snapshot: KeybindingFileSnapshot = {
      path: '/test/keybindings.json',
      platform: 'darwin',
      exists: true,
      overrides: {},
      commonOverrides: {},
      platformOverrides: {},
      diagnostics: []
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { getSync: () => settings, get: async () => settings, onChanged: () => () => {} },
        keybindings: {
          get: async () => snapshot,
          onChanged: (listener: (next: KeybindingFileSnapshot) => void) => {
            listeners.add(listener)
            subscribed.push(listener)
            return () => listeners.delete(listener)
          }
        }
      }
    })
    try {
      platform.value = 'darwin'
      const close = vi.spyOn(window, 'close').mockImplementation(() => {})
      const press = (key: string, code: string, shiftKey = false): void => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            metaKey: true,
            key,
            code,
            shiftKey
          })
        )
      }
      const root = document.createElement('div')
      root.id = 'root'
      document.body.append(root)
      await act(async () => {
        await import('../../popout')
      })
      press('w', 'KeyW')
      expect(close).toHaveBeenCalledOnce()
      const updated = { ...snapshot, overrides: { 'tab.close': ['Mod+Shift+Y'] } }
      act(() => {
        for (const listener of listeners) {
          listener(updated)
        }
      })
      press('w', 'KeyW')
      expect(close).toHaveBeenCalledOnce()
      press('Y', 'KeyY', true)
      expect(close).toHaveBeenCalledTimes(2)
      expect(listeners.size).toBe(1)
      cleanup()
      expect(listeners.size).toBe(0)
      const afterUnmount = useAppStore.getState().keybindingSnapshot
      for (const listener of subscribed) {
        listener(snapshot)
      }
      expect(useAppStore.getState().keybindingSnapshot).toBe(afterUnmount)
    } finally {
      cleanup()
      useAppStore.setState(initial, true)
      for (const name of document.documentElement.getAttributeNames()) {
        document.documentElement.removeAttribute(name)
      }
      for (const [name, value] of originalAttributes) {
        document.documentElement.setAttribute(name, value)
      }
      if (originalApi) {
        Object.defineProperty(window, 'api', originalApi)
      } else {
        Reflect.deleteProperty(window, 'api')
      }
    }
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'closes with the configured chord while preserving preview ownership on %s',
    (value) => {
      platform.value = value
      const close = vi.spyOn(window, 'close').mockImplementation(() => {})
      const mod = value === 'darwin' ? { metaKey: true } : { ctrlKey: true }
      const press = (target: EventTarget, init: KeyboardEventInit): void => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...mod, ...init })
        )
      }
      const view = render(<DashboardPopoutRoot />)
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.append(dialog)
      press(dialog, { key: 'w', code: 'KeyW' })
      const consume = (event: Event): void => event.preventDefault()
      window.addEventListener('keydown', consume, true)
      press(document.body, { key: 'w', code: 'KeyW' })
      window.removeEventListener('keydown', consume, true)
      expect(close).not.toHaveBeenCalled()

      press(document.body, { key: 'w', code: 'KeyW' })
      expect(close).toHaveBeenCalledOnce()
      useAppStore.setState({ keybindings: { 'tab.close': ['Mod+Shift+Y'] } })
      press(document.body, { key: 'w', code: 'KeyW' })
      expect(close).toHaveBeenCalledOnce()
      press(document.body, { key: 'Y', code: 'KeyY', shiftKey: true })
      expect(close).toHaveBeenCalledTimes(2)

      view.unmount()
      press(document.body, { key: 'Y', code: 'KeyY', shiftKey: true })
      expect(close).toHaveBeenCalledTimes(2)
    }
  )

  it('honors a double-tap override without closing on a single or interrupted tap', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    useAppStore.setState({ keybindings: { 'tab.close': ['DoubleTap+Ctrl'] } })
    const view = render(<DashboardPopoutRoot />)
    const press = (type: 'keydown' | 'keyup', target: EventTarget = document.body): void => {
      target.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          key: 'Control',
          code: 'ControlLeft',
          ctrlKey: type === 'keydown'
        })
      )
      now += 50
    }
    const tap = (): void => {
      press('keydown')
      press('keyup')
    }
    tap()
    expect(close).not.toHaveBeenCalled()
    press('keydown')
    expect(close).toHaveBeenCalledOnce()
    press('keyup')

    for (const event of ['blur', 'focusin', 'prevented']) {
      tap()
      if (event === 'prevented') {
        window.addEventListener('keydown', (e) => e.preventDefault(), {
          capture: true,
          once: true
        })
        tap()
      } else {
        window.dispatchEvent(new Event(event))
      }
      press('keydown')
      expect(close).toHaveBeenCalledOnce()
      press('keyup')
      now += 400
    }
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    tap()
    press('keydown', dialog)
    press('keyup', dialog)
    press('keydown')
    expect(close).toHaveBeenCalledOnce()
    press('keyup')
    view.unmount()
    tap()
    tap()
    expect(close).toHaveBeenCalledOnce()
  })
})

// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const platform = vi.hoisted(() => ({ value: 'darwin' }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => platform.value }))
vi.mock('@/hooks/useAppMenuPaste', () => ({ useAppMenuPaste: () => {} }))
vi.mock('@/hooks/useAppMenuSelectionActions', () => ({ useAppMenuSelectionActions: () => {} }))
vi.mock('./use-agent-dashboard-telemetry', () => ({ useAgentDashboardTelemetry: () => {} }))
vi.mock('./AgentKanbanBoard', () => ({ AgentKanbanBoard: () => null }))
vi.mock('./useDashboardSnapshot', () => ({ useDashboardSnapshot: () => null }))

import { DashboardPopoutRoot } from './DashboardPopoutRoot'

describe('dashboard pop-out close shortcut', () => {
  const initialKeybindings = useAppStore.getState().keybindings

  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    useAppStore.setState({ keybindings: initialKeybindings })
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

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
})

// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { APP_MENU_SELECTION_ACTION_EVENT } from '@/lib/app-menu-selection-actions'

const useAgentDashboardTelemetry = vi.hoisted(() => vi.fn())
vi.mock('./use-agent-dashboard-telemetry', () => ({ useAgentDashboardTelemetry }))
vi.mock('./AgentKanbanBoard', () => ({ AgentKanbanBoard: () => null }))
vi.mock('./useDashboardSnapshot', () => ({ useDashboardSnapshot: () => null }))

import { DashboardPopoutRoot } from './DashboardPopoutRoot'

describe('DashboardPopoutRoot', () => {
  const performNativePaste = vi.fn()
  const performNativeSelectionAction = vi.fn()
  let emitAppMenuPaste: (() => void) | null = null
  let emitAppMenuSelectionAction: ((action: 'copy' | 'select-all') => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    emitAppMenuPaste = null
    emitAppMenuSelectionAction = null
    Object.assign(window, {
      api: {
        ui: {
          readClipboardText: vi.fn(async () => ''),
          performNativePaste,
          performNativeSelectionAction,
          onAppMenuPaste: (listener: () => void) => {
            emitAppMenuPaste = listener
            return vi.fn()
          },
          onEditableContextPaste: () => vi.fn(),
          onAppMenuSelectionAction: (listener: (action: 'copy' | 'select-all') => void) => {
            emitAppMenuSelectionAction = listener
            return vi.fn()
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  // Without an App shell, these hooks alone translate menu IPC for preview ownership listeners.
  it('translates app-menu clipboard IPC into renderer ownership events', async () => {
    const onPaste = vi.fn()
    const onSelectionAction = vi.fn()
    window.addEventListener(APP_MENU_PASTE_EVENT, onPaste)
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)
    render(<DashboardPopoutRoot />)
    expect(useAgentDashboardTelemetry).toHaveBeenCalledWith('popout')
    expect(emitAppMenuPaste).not.toBeNull()
    expect(emitAppMenuSelectionAction).not.toBeNull()

    await act(async () => emitAppMenuPaste!())
    act(() => emitAppMenuSelectionAction!('select-all'))
    window.removeEventListener(APP_MENU_PASTE_EVENT, onPaste)
    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)

    expect(onPaste).toHaveBeenCalledOnce()
    expect(onSelectionAction).toHaveBeenCalledOnce()
    // Unclaimed here (no preview mounted), so both still reach the native path.
    expect(performNativePaste).toHaveBeenCalledOnce()
    expect(performNativeSelectionAction).toHaveBeenCalledWith('select-all')
  })
})

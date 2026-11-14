// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FloatingWorkspaceWindowSnapshot } from '../../../../shared/floating-workspace-window'
import { FloatingWorkspaceWindowRoot } from './FloatingWorkspaceWindowRoot'

vi.mock('@/hooks/clipboard/menu/useAppMenuPaste', () => ({ useAppMenuPaste: () => undefined }))
vi.mock('@/hooks/app-commands/useAppMenuSelectionActions', () => ({
  useAppMenuSelectionActions: () => undefined
}))

afterEach(cleanup)

it('renders the active tab header without an app-level tooltip provider', async () => {
  const snapshot: FloatingWorkspaceWindowSnapshot = {
    version: 1,
    activeTab: {
      tabId: 'tab-1',
      title: 'Build notes',
      kind: 'other',
      status: 'working',
      paneKey: 'tab-1:1',
      ptyId: null
    }
  }
  const requestDock = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      floatingWorkspaceWindow: {
        onSnapshot: () => () => undefined,
        requestSnapshot: async () => snapshot,
        ackAgent: vi.fn(),
        requestDock
      }
    }
  })

  render(<FloatingWorkspaceWindowRoot />)

  expect(await screen.findByText('Build notes')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Dock' }))
  expect(requestDock).toHaveBeenCalledOnce()
})

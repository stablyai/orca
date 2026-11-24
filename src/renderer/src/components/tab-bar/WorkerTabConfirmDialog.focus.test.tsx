// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import WorkerTabConfirmDialog, { requestWorkerTabConfirm } from './WorkerTabConfirmDialog'

vi.mock('./worker-tab-explicit-actions', () => ({
  closeWorkerTab: vi.fn(),
  stopWorker: vi.fn(),
  explainWorkerTabHomeStop: vi.fn()
}))

afterEach(() => {
  act(() => screen.queryByRole('button', { name: 'Cancel' })?.click())
  cleanup()
})

it.each(['stop', 'close-running', 'close-finished'] as const)(
  'opens the %s worker confirmation with Cancel focused',
  async (kind) => {
    render(<WorkerTabConfirmDialog />)
    act(() => {
      requestWorkerTabConfirm({
        kind,
        worktreeId: 'wt',
        tab: makeUnifiedTab({ id: 'worker', worktreeId: 'wt', groupId: 'group' })
      })
    })
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    })
  }
)

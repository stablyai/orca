// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OdooTicket } from '../../../shared/odoo-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  toastWarning: vi.fn(),
  droppedByCap: { current: 0 }
}))

vi.mock('sonner', () => ({
  toast: { warning: mocks.toastWarning, success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      allWorktrees: () => [],
      odooStatus: { connected: true, viewer: { uid: 1 }, instances: [] },
      settings: { activeRuntimeEnvironmentId: null },
      createWorktree: vi.fn()
    })
  }
}))

vi.mock('@/components/odoo-auto-workspace-settings', () => ({
  readOdooAutoWorkspaceSettings: () => ({
    enabled: true,
    repoId: 'repo-1',
    baseBranch: null,
    criteria: {},
    maxPerRun: 1
  })
}))

vi.mock('@/components/odoo-auto-workspace-criteria', () => ({
  selectOdooAutoWorkspaceCandidates: (tickets: readonly OdooTicket[]) => ({
    selected: tickets,
    droppedByCap: mocks.droppedByCap.current
  })
}))

// Returning null makes the creation loop skip every ticket, so the test only
// exercises the cap notice.
vi.mock('@/components/task-page-odoo-item-source-context', () => ({
  bindTaskPageOdooItemSourceContext: () => null
}))

const ticket = {
  id: 72,
  ref: 'TASK-72',
  title: 'Chatter',
  url: 'https://odoo.test/72'
} as OdooTicket

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.toastWarning.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function runAutoWorkspace(droppedByCap: number): Promise<void> {
  mocks.droppedByCap.current = droppedByCap
  const { useOdooAutoWorkspace } = await import('./use-odoo-auto-workspace')
  let run: ((tickets: readonly OdooTicket[]) => void) | null = null
  function Probe(): null {
    run = useOdooAutoWorkspace()
    return null
  }
  await act(async () => root.render(<Probe />))
  await act(async () => {
    run?.([ticket])
  })
}

describe('useOdooAutoWorkspace cap notice', () => {
  it('uses the singular form for a single skipped ticket', async () => {
    await runAutoWorkspace(1)

    expect(mocks.toastWarning).toHaveBeenCalledWith(
      '1 more matching ticket was skipped by the per-run limit.'
    )
  })

  it('uses the plural form for several skipped tickets', async () => {
    await runAutoWorkspace(3)

    expect(mocks.toastWarning).toHaveBeenCalledWith(
      '3 more matching tickets were skipped by the per-run limit.'
    )
  })
})

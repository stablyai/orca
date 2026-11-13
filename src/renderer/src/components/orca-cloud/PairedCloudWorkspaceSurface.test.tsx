// @vitest-environment happy-dom
// SLEEP-IN-PROGRESS (2/2): a PAIRED cloud workspace gets the waking overlay, the asleep sealed copy
// with Wake to continue, and the saving / failed states after a Sleep pressed here.

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadSnapshot } from '../../../../shared/cloud-workspaces/read-snapshot'
import type { CloudReadSnapshotState } from '../../../../shared/cloud-workspaces/read-snapshot-state'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  SLEEP_COPY_DEADLINE_MS,
  markSleepCopySaving,
  resetWorktreeSleepViewForTests
} from '@/lib/worktree-sleep-view'
import { OrcaCloudWorkspaceSurface } from './OrcaCloudWorkspaceSurface'
import { SEALED_COPY_POLL_MS } from './PairedCloudWorkspaceSurface'

const wakePaired = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })))
vi.mock('@/lib/orca-cloud/paired-cloud-wake', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  wakePairedCloudWorkspace: wakePaired
}))
vi.mock('@/lib/orca-cloud/cloud-host-rows', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCloudRowSandboxId: async () => 'sbx_paired'
}))
vi.mock('@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'inactive'
}))

const T0 = 1_800_000_000_000
const ID = 'repo::/workspace/orca-sandbox-paired'

const status = (state: 'sleeping' | 'ready') => ({
  status: {
    state,
    metrics: null,
    uptimeMs: 0,
    usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
    archive: null,
    checkedAt: T0
  },
  loading: false,
  error: null,
  fetchedAt: T0
})

const copy = (capturedAt: number): ReadSnapshot => ({
  v: 1,
  workspaceId: 'sbx_paired',
  snapshotId: `snap_${capturedAt}`,
  capturedAt,
  reason: 'sleep',
  pr: null,
  sessions: [],
  git: {
    branch: 'paired-branch',
    head: 'abc1234',
    changeCount: 0,
    added: null,
    removed: null,
    changes: [],
    commits: []
  }
})

let reads: CloudReadSnapshotState[]
const readSnapshot = vi.fn(async () => ({
  ok: true as const,
  value: reads.length > 1 ? (reads.shift() ?? reads[0]) : reads[0]
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  resetWorktreeSleepViewForTests()
  wakePaired.mockClear()
  readSnapshot.mockClear()
  reads = [{ state: 'no_snapshot' }]
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cloudWorkspaces: { readSnapshot },
      orcaCloudWorkspace: { getStatus: async () => ({ ok: false, message: 'offline' }) }
    }
  })
})

afterEach(() => {
  cleanup()
  seedCloudWorkspaceSnapshot({})
  resetWorktreeSleepViewForTests()
  vi.useRealTimers()
})

function seedPaired(
  state: 'sleeping' | 'ready',
  extra: Parameters<typeof seedCloudWorkspaceSnapshot>[0] = {}
) {
  seedCloudWorkspaceSnapshot({
    paired: { [ID]: 'env-paired' },
    status: { [ID]: status(state) },
    idsLoaded: true,
    ...extra
  })
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('the paired cloud workspace surface', () => {
  it('a paired row waking shows the waking overlay; Try again wakes it through the control plane', async () => {
    seedPaired('sleeping', {
      wake: {
        [ID]: { workspaceId: ID, phase: 'waking', source: 'open', startedAt: T0 - 2_000, at: T0 }
      }
    })
    const { container } = render(<OrcaCloudWorkspaceSurface worktreeId={ID} />)
    await flush()
    expect(container.querySelector('[data-cloud-cover="waking"]')).not.toBeNull()
    // PAIRED-WAKE-TYPE-THROUGH: while it wakes the pane underneath stays typeable, like owned.
    expect(container.querySelector('[data-cloud-cover="waking"]')?.className).toContain(
      'pointer-events-none'
    )
    act(() =>
      seedPaired('sleeping', {
        wake: {
          [ID]: {
            workspaceId: ID,
            phase: 'failed',
            source: 'open',
            startedAt: T0 - 2_000,
            at: T0,
            message: 'boom'
          }
        }
      })
    )
    await flush()
    const retry = Array.from(container.querySelectorAll('button')).find((b) =>
      /Try again/.test(b.textContent ?? '')
    )
    expect(retry).toBeDefined()
    // A failed wake covers the pane again: nothing typed there would reach a terminal.
    expect(container.querySelector('[data-cloud-cover="waking"]')?.className).not.toContain(
      'pointer-events-none'
    )
    fireEvent.click(retry!)
    expect(wakePaired).toHaveBeenCalledWith(ID)
  })

  it('a paired asleep row shows its sealed copy; Wake to continue wakes it', async () => {
    reads = [{ state: 'ready', snapshot: copy(T0 - 60_000), storedAt: T0 }]
    seedPaired('sleeping')
    const { container, getByRole } = render(<OrcaCloudWorkspaceSurface worktreeId={ID} />)
    await flush()
    expect(readSnapshot).toHaveBeenCalledWith('sbx_paired')
    expect(container.querySelector('[data-cloud-cover="asleep"]')).not.toBeNull()
    expect(container.textContent).toContain('paired-branch')
    fireEvent.click(getByRole('button', { name: 'Wake to continue' }))
    expect(wakePaired).toHaveBeenCalledWith(ID, { source: 'open' })
  })

  it('after a paired Sleep: saving (never the empty states) until a new-enough sealed copy is read', async () => {
    // The old copy, then nothing new, then the one this Sleep sealed.
    reads = [
      { state: 'ready', snapshot: copy(T0 - 60_000), storedAt: T0 },
      { state: 'no_snapshot' },
      { state: 'ready', snapshot: copy(T0 + 1_000), storedAt: T0 + 1_000 }
    ]
    markSleepCopySaving(ID, T0)
    seedPaired('ready')
    const { container, queryByRole } = render(<OrcaCloudWorkspaceSurface worktreeId={ID} />)
    await flush()
    expect(container.textContent).toContain('Saving a read-only copy…')
    expect(container.textContent).not.toContain('paired-branch')
    expect(container.textContent).not.toContain('Nothing saved yet')
    expect(queryByRole('button', { name: 'Wake to continue' })).toBeNull()
    await flush(SEALED_COPY_POLL_MS)
    expect(container.textContent).toContain('Saving a read-only copy…')
    expect(container.textContent).not.toContain('Nothing saved yet')
    act(() => seedPaired('sleeping'))
    await flush(SEALED_COPY_POLL_MS)
    expect(readSnapshot).toHaveBeenCalledTimes(3)
    expect(container.textContent).not.toContain('Saving a read-only copy…')
    expect(container.textContent).toContain('paired-branch')
    expect(queryByRole('button', { name: 'Wake to continue' })).not.toBeNull()
  })

  it('no sealed copy by the deadline: the failed line, with the header Wake as the one Wake', async () => {
    markSleepCopySaving(ID, T0)
    seedPaired('sleeping')
    const { container, getAllByRole } = render(<OrcaCloudWorkspaceSurface worktreeId={ID} />)
    await flush(SLEEP_COPY_DEADLINE_MS)
    expect(container.querySelector('[data-cloud-sleep-copy="failed"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Nothing saved yet')
    expect(getAllByRole('button', { name: /Wake/ })).toHaveLength(1)
    // Polling stopped with the deadline.
    const calls = readSnapshot.mock.calls.length
    await flush(SEALED_COPY_POLL_MS * 3)
    expect(readSnapshot.mock.calls.length).toBe(calls)
  })

  it('an owned row never mounts the paired layer, and a non-cloud row renders nothing', async () => {
    seedCloudWorkspaceSnapshot({
      ids: new Set([ID]),
      status: { [ID]: status('ready') },
      idsLoaded: true
    })
    const owned = render(<OrcaCloudWorkspaceSurface worktreeId={ID} />)
    await flush()
    expect(owned.container.querySelector('[data-cloud-paired]')).toBeNull()
    expect(owned.container.querySelector('[data-cloud-surface]')).not.toBeNull()
    owned.unmount()
    seedCloudWorkspaceSnapshot({ idsLoaded: true })
    const plain = render(<OrcaCloudWorkspaceSurface worktreeId="local::/repo" />)
    await flush()
    expect(plain.container.innerHTML).toBe('')
    expect(readSnapshot).not.toHaveBeenCalled()
  })
})

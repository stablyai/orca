import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { Repo } from '../../../../../shared/repo-types'
import { setProjectHidden } from './set-project-hidden'

const { toastSuccess, toastInfo, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, info: toastInfo, error: toastError }
}))

const initialState = useAppStore.getState()
const local: Repo = { ...TEST_REPO, id: 'r' }
let clock = 1000

// Writes land in the store, as a host that echoes hiddenAt would.
const updateRepo = vi.fn(
  async (id: string, updates: { hiddenAt?: number | null }, options?: { hostId?: string }) => {
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) => {
        if (repo.id !== id || getRepoExecutionHostId(repo) !== options?.hostId) {
          return repo
        }
        const { hiddenAt: _previous, ...rest } = repo
        return typeof updates.hiddenAt === 'number' ? { ...rest, hiddenAt: updates.hiddenAt } : rest
      })
    }))
    return true
  }
)

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1))
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function undo(toastIndex = 0): void {
  const options: unknown = toastSuccess.mock.calls[toastIndex]?.[1]
  if (
    typeof options !== 'object' ||
    options === null ||
    !('action' in options) ||
    typeof options.action !== 'object' ||
    options.action === null ||
    !('onClick' in options.action) ||
    typeof options.action.onClick !== 'function'
  ) {
    throw new Error('expected an Undo action on the hide toast')
  }
  options.action.onClick()
}

describe('setProjectHidden', () => {
  it('leaves a newer hide in place when an older toast’s Undo is clicked', async () => {
    useAppStore.setState({ repos: [local], updateRepo })
    await setProjectHidden([local], true, 'r')
    await setProjectHidden([local], false, 'r')
    await setProjectHidden([local], true, 'r')
    const newerHiddenAt = useAppStore.getState().repos[0]?.hiddenAt
    updateRepo.mockClear()

    undo(0)
    await Promise.resolve()

    expect(updateRepo).not.toHaveBeenCalled()
    expect(useAppStore.getState().repos[0]?.hiddenAt).toBe(newerHiddenAt)
  })
})

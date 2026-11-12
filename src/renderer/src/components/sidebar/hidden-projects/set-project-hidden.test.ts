import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
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
const local = { ...TEST_REPO, id: 'r' }
const onBox = { ...TEST_REPO, id: 'r', connectionId: 'box' }

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

function undo(): void {
  const options: unknown = toastSuccess.mock.calls[0]?.[1]
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
  it('hides every host copy a header shows in one action, and one Undo shows them all', async () => {
    const updateRepo = vi.fn(async () => true)
    useAppStore.setState({ repos: [local, onBox], updateRepo })

    await setProjectHidden([local, onBox], true, 'r')

    expect(updateRepo.mock.calls).toEqual([
      ['r', { hiddenAt: expect.any(Number) }, { hostId: 'local' }],
      ['r', { hiddenAt: expect.any(Number) }, { hostId: 'ssh:box' }]
    ])
    expect(toastSuccess).toHaveBeenCalledOnce()

    updateRepo.mockClear()
    undo()
    await vi.waitFor(() => expect(updateRepo).toHaveBeenCalledTimes(2))
    expect(updateRepo.mock.calls).toEqual([
      ['r', { hiddenAt: null }, { hostId: 'local' }],
      ['r', { hiddenAt: null }, { hostId: 'ssh:box' }]
    ])
  })

  it('answers Undo neutrally when the project was removed meanwhile', async () => {
    const updateRepo = vi.fn(async () => true)
    useAppStore.setState({ repos: [local], updateRepo })
    await setProjectHidden([local], true, 'r')

    useAppStore.setState({ repos: [] })
    updateRepo.mockClear()
    undo()

    await vi.waitFor(() => expect(toastInfo).toHaveBeenCalledOnce())
    expect(updateRepo).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })
})

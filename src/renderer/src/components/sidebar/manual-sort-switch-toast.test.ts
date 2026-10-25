import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { switchSortToManualAfterDrop } from './manual-sort-switch-toast'

const { toastInfo, toastDismiss } = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastDismiss: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info: toastInfo, dismiss: toastDismiss } }))

const initialState = useAppStore.getInitialState()

type ToastOptions = {
  id?: string
  onDismiss?: () => void
  action?: { label: string; onClick: () => void }
}

function lastToastOptions(): ToastOptions {
  const options: unknown = toastInfo.mock.calls.at(-1)?.[1]
  expect(options).toBeTypeOf('object')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: asserted to be the options object passed to toast.info above.
  return options as ToastOptions
}

describe('switchSortToManualAfterDrop', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    toastInfo.mockClear()
    toastDismiss.mockClear()
  })

  afterEach(() => {
    if (toastInfo.mock.calls.length > 0) {
      lastToastOptions().onDismiss?.()
    }
    useAppStore.setState(initialState, true)
  })

  it('switches to Manual and offers a way back to the previous sort', () => {
    useAppStore.setState({ sortBy: 'smart' })
    switchSortToManualAfterDrop()

    expect(useAppStore.getState().sortBy).toBe('manual')
    expect(toastInfo).toHaveBeenCalledTimes(1)
    const options = lastToastOptions()
    expect(options.action?.label).toBe('Back to Agent Activity')

    options.action?.onClick()
    expect(useAppStore.getState().sortBy).toBe('smart')
  })

  it('does nothing when Manual is already active', () => {
    useAppStore.setState({ sortBy: 'manual' })
    switchSortToManualAfterDrop()

    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('retires the toast once the user picks another sort', () => {
    useAppStore.setState({ sortBy: 'recent' })
    switchSortToManualAfterDrop()
    const options = lastToastOptions()

    useAppStore.setState({ sortBy: 'name' })
    expect(toastDismiss).toHaveBeenCalledWith(options.id)

    // A round trip back to Manual must not let the stale action override it.
    useAppStore.setState({ sortBy: 'manual' })
    options.action?.onClick()
    expect(useAppStore.getState().sortBy).toBe('manual')
  })
})

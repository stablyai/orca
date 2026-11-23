// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClickUpMutationResult } from '../../../../../shared/clickup/clickup-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ClickUpTokenDialog } from './clickup-token-dialog'

const store = vi.hoisted(() => ({ connectClickUp: vi.fn() }))

vi.mock('@/store/index', () => ({
  useAppStore: function useAppStore<T>(selector: (state: typeof store) => T): T {
    return selector(store)
  }
}))

const local: RuntimeClientTarget = { kind: 'local' }
const remote: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-1' }

function tokenInput(): HTMLInputElement {
  const input = document.querySelector('input[type="password"]')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('token input missing')
  }
  return input
}

function submitForm(): void {
  const { form } = tokenInput()
  if (!form) {
    throw new Error('token form missing')
  }
  fireEvent.submit(form)
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('ClickUpTokenDialog', () => {
  it('clears the typed token when the owner changes while the dialog is open', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <ClickUpTokenDialog owner={local} open onOpenChange={onOpenChange} />
    )
    fireEvent.change(tokenInput(), { target: { value: 'pk_for_local' } })
    expect(tokenInput().value).toBe('pk_for_local')

    rerender(<ClickUpTokenDialog owner={remote} open onOpenChange={onOpenChange} />)

    expect(tokenInput().value).toBe('')
    expect(store.connectClickUp).not.toHaveBeenCalled()
  })

  it('ignores the outcome of a connect started for the previous owner', async () => {
    let settle!: (result: ClickUpMutationResult) => void
    store.connectClickUp.mockReturnValue(
      new Promise<ClickUpMutationResult>((resolve) => {
        settle = resolve
      })
    )
    const onOpenChange = vi.fn()
    const onConnected = vi.fn()
    const { rerender } = render(
      <ClickUpTokenDialog
        owner={local}
        open
        onOpenChange={onOpenChange}
        onConnected={onConnected}
      />
    )
    fireEvent.change(tokenInput(), { target: { value: 'pk_for_local' } })
    submitForm()
    expect(store.connectClickUp).toHaveBeenCalledWith(local, 'pk_for_local')

    rerender(
      <ClickUpTokenDialog
        owner={remote}
        open
        onOpenChange={onOpenChange}
        onConnected={onConnected}
      />
    )
    await act(async () => {
      settle({ ok: true })
    })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onConnected).not.toHaveBeenCalled()
    expect(tokenInput().value).toBe('')
    expect(tokenInput().disabled).toBe(false)
  })

  it('ignores a connect from before the owner changed away and back', async () => {
    let settle!: (result: ClickUpMutationResult) => void
    store.connectClickUp.mockReturnValue(
      new Promise<ClickUpMutationResult>((resolve) => {
        settle = resolve
      })
    )
    const onOpenChange = vi.fn()
    const onConnected = vi.fn()
    const dialog = (owner: RuntimeClientTarget): React.JSX.Element => (
      <ClickUpTokenDialog
        owner={owner}
        open
        onOpenChange={onOpenChange}
        onConnected={onConnected}
      />
    )
    const { rerender } = render(dialog(local))
    fireEvent.change(tokenInput(), { target: { value: 'pk_first_local' } })
    submitForm()

    rerender(dialog(remote))
    rerender(dialog(local))
    fireEvent.change(tokenInput(), { target: { value: 'pk_typed_after_return' } })
    await act(async () => {
      settle({ ok: true })
    })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onConnected).not.toHaveBeenCalled()
    expect(tokenInput().value).toBe('pk_typed_after_return')
  })

  it('applies the outcome of a connect when the owner is replaced by an equal one', async () => {
    let settle!: (result: ClickUpMutationResult) => void
    store.connectClickUp.mockReturnValue(
      new Promise<ClickUpMutationResult>((resolve) => {
        settle = resolve
      })
    )
    const onOpenChange = vi.fn()
    const onConnected = vi.fn()
    const dialog = (owner: RuntimeClientTarget): React.JSX.Element => (
      <StrictMode>
        <ClickUpTokenDialog
          owner={owner}
          open
          onOpenChange={onOpenChange}
          onConnected={onConnected}
        />
      </StrictMode>
    )
    const { rerender } = render(dialog(remote))
    fireEvent.change(tokenInput(), { target: { value: 'pk_for_remote' } })
    submitForm()

    rerender(dialog({ kind: 'environment', environmentId: 'env-1' }))
    await act(async () => {
      settle({ ok: true })
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConnected).toHaveBeenCalledTimes(1)
  })
})

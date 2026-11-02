// @vitest-environment happy-dom

import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { TooltipProvider } from '../ui/tooltip'
import { DeleteWorktreeDialogFooter } from './DeleteWorktreeDialogFooter'

const savePreference = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ updateSettingsOrThrow: savePreference }) }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }))
let root: Root | undefined

function renderFooter(disabled = false) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const onForceDelete = vi.fn()
  const onSavingChange = vi.fn()
  const confirmButtonRef = createRef<HTMLButtonElement>()
  act(() =>
    root?.render(
      <TooltipProvider delayDuration={0}>
        <DeleteWorktreeDialogFooter
          isMainWorktree={false}
          isDeleting={disabled}
          canForceDelete
          isBatchDelete={false}
          worktreeCount={1}
          canDeleteAllLineage={false}
          lineageDeleteTargetCount={1}
          onCancel={vi.fn()}
          onDelete={vi.fn()}
          onForceDelete={onForceDelete}
          onSavingChange={onSavingChange}
          confirmButtonRef={confirmButtonRef}
        />
      </TooltipProvider>
    )
  )
  return { container, onForceDelete, onSavingChange, confirmButtonRef }
}

async function selectPreference(container: HTMLElement) {
  await act(async () => {
    container
      .querySelector('button[aria-label="More force delete options"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  const item = document.querySelector('[role="menuitem"]')
  if (!(item instanceof HTMLElement)) {
    throw new Error('Missing preference option')
  }
  await act(async () => item.click())
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

it('keeps the primary button focused, full size, and a one-time delete', async () => {
  const { confirmButtonRef, onForceDelete } = renderFooter()
  expect(confirmButtonRef.current?.dataset.size).toBe('default')
  expect(confirmButtonRef.current?.textContent).toBe('Force Delete')
  await act(async () => confirmButtonRef.current?.click())
  expect(onForceDelete).toHaveBeenCalledOnce()
  expect(savePreference).not.toHaveBeenCalled()
  expect(toast.dismiss).not.toHaveBeenCalled()
})

it('saves the shared preference before retrying and exposes the pending state', async () => {
  let finish: (() => void) | undefined
  savePreference.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { container, onForceDelete, onSavingChange } = renderFooter()
  await selectPreference(container)
  expect(savePreference).toHaveBeenCalledWith({ alwaysForceDeleteWorktrees: true })
  expect(onForceDelete).not.toHaveBeenCalled()
  expect(onSavingChange).toHaveBeenLastCalledWith(true)
  expect(container.querySelectorAll('button:disabled')).toHaveLength(2)
  await act(async () => finish?.())
  expect(onSavingChange).toHaveBeenLastCalledWith(false)
  expect(onForceDelete).toHaveBeenCalledOnce()
})

it('leaves the recovery action available when saving fails', async () => {
  savePreference.mockRejectedValue(new Error('Disk full'))
  const { container, onForceDelete, onSavingChange } = renderFooter()
  await selectPreference(container)
  expect(onForceDelete).not.toHaveBeenCalled()
  expect(onSavingChange).toHaveBeenLastCalledWith(false)
  expect(container.querySelectorAll('button:disabled')).toHaveLength(0)
  expect(toast.error).toHaveBeenCalledWith('Could not save deletion preference', {
    description: 'Disk full'
  })
})

it('disables both retry choices while deletion is in progress', () => {
  const { container } = renderFooter(true)
  expect(container.querySelectorAll('button:disabled')).toHaveLength(3)
})

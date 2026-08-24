// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppearanceUnsavedChangesDialog } from './AppearanceUnsavedChangesDialog'

const mountedRoots: Root[] = []

async function renderDialog(
  props: Partial<React.ComponentProps<typeof AppearanceUnsavedChangesDialog>> = {}
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(
      <AppearanceUnsavedChangesDialog
        open
        saving={false}
        saveFailed={false}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        onCancel={vi.fn()}
        {...props}
      />
    )
  })
  await act(() => Promise.resolve())
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === label
  )
}

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('AppearanceUnsavedChangesDialog', () => {
  it('only renders its content while open and focuses Save by default', async () => {
    await renderDialog({ open: false })
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await renderDialog()

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Unsaved appearance changes')
    expect(document.body.textContent).toContain('Save the appearance draft before leaving?')
    expect(document.activeElement).toBe(findButton('Save'))
  })

  it('invokes Save, Discard, and Cancel from their actions', async () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    const onCancel = vi.fn()
    await renderDialog({ onSave, onDiscard, onCancel })

    await act(async () => {
      findButton('Save')?.click()
      findButton('Discard')?.click()
      findButton('Cancel')?.click()
    })

    expect(onSave).toHaveBeenCalledOnce()
    expect(onDiscard).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('disables every action immediately and delays the saving indicator', async () => {
    vi.useFakeTimers()
    await renderDialog({ saving: true })

    expect(findButton('Save')?.disabled).toBe(true)
    expect(findButton('Discard')?.disabled).toBe(true)
    expect(findButton('Cancel')?.disabled).toBe(true)

    act(() => vi.advanceTimersByTime(749))
    expect(findButton('Save')).toBeDefined()
    expect(document.body.textContent).not.toContain('Saving…')

    act(() => vi.advanceTimersByTime(1))
    expect(findButton('Saving…')?.disabled).toBe(true)
  })

  it('keeps the draft recovery message visible after a save failure', async () => {
    await renderDialog({ saveFailed: true })

    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(
      'Appearance settings could not be saved. The draft is still available.'
    )
  })
})

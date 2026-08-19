// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppearanceSaveBar } from './AppearanceSaveBar'

const mountedRoots: Root[] = []

async function renderSaveBar(
  props: Partial<React.ComponentProps<typeof AppearanceSaveBar>> = {}
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(
      <AppearanceSaveBar
        changeCount={1}
        saving={false}
        saveFailed={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onDiscard={vi.fn()}
        {...props}
      />
    )
  })

  return container
}

function findButton(container: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
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

describe('AppearanceSaveBar', () => {
  it('stays hidden without changes or a save failure', async () => {
    const container = await renderSaveBar({ changeCount: 0 })

    expect(container.textContent).toBe('')
  })

  it.each([
    [1, '1 unsaved change'],
    [2, '2 unsaved changes']
  ])('pluralizes a count of %i', async (changeCount, label) => {
    const container = await renderSaveBar({ changeCount })

    expect(container.textContent).toContain(label)
  })

  it('invokes Save and Discard', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onDiscard = vi.fn()
    const container = await renderSaveBar({ changeCount: 2, onSave, onDiscard })

    await act(async () => {
      findButton(container, 'Save')?.click()
      findButton(container, 'Discard')?.click()
    })

    expect(onSave).toHaveBeenCalledOnce()
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('disables actions immediately and delays the saving indicator', async () => {
    vi.useFakeTimers()
    const container = await renderSaveBar({ saving: true })

    expect(findButton(container, 'Save')?.disabled).toBe(true)
    expect(findButton(container, 'Discard')?.disabled).toBe(true)

    act(() => vi.advanceTimersByTime(749))
    expect(findButton(container, 'Save')).toBeDefined()
    expect(container.textContent).not.toContain('Saving…')

    act(() => vi.advanceTimersByTime(1))
    expect(findButton(container, 'Saving…')?.disabled).toBe(true)
  })

  it('remains visible with failure guidance when no changes are left', async () => {
    const container = await renderSaveBar({ changeCount: 0, saveFailed: true })

    expect(container.textContent).toContain('0 unsaved changes')
    expect(container.textContent).toContain('Appearance settings could not be saved. Try again.')
    expect(findButton(container, 'Save')?.disabled).toBe(true)
    expect(findButton(container, 'Discard')?.disabled).toBe(false)
  })
})

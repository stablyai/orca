// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import PinnedTabCloseDialog from './PinnedTabCloseDialog'

const initialState = useAppStore.getInitialState()
const mountedRoots: Root[] = []

async function renderDialog({
  tabLabel = 'Docs',
  onConfirm,
  onCancel,
  updateSettings
}: {
  tabLabel?: string
  onConfirm: () => void
  onCancel?: () => void
  updateSettings: AppState['updateSettings']
}): Promise<void> {
  useAppStore.setState({
    settings: { confirmClosePinnedTab: true } as AppState['settings'],
    updateSettings
  })
  useAppStore.getState().requestPinnedTabCloseConfirm({
    tabLabel,
    onConfirm,
    ...(onCancel ? { onCancel } : {})
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(<PinnedTabCloseDialog />)
  })
}

function getButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function getCheckbox(): HTMLButtonElement {
  const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')
  if (!checkbox) {
    throw new Error('Checkbox not found')
  }
  return checkbox
}

describe('PinnedTabCloseDialog', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
    useAppStore.setState(initialState, true)
  })

  it('confirms without changing the preference by default', async () => {
    const onConfirm = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await renderDialog({ onConfirm, updateSettings })

    expect(document.body.textContent).toContain('Close pinned tab?')
    expect(document.body.textContent).toContain("Don't ask again for pinned tabs")

    await act(async () => {
      getButton('Close').click()
    })

    expect(updateSettings).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('turns off future pinned-tab confirmations when checked and confirmed', async () => {
    const onConfirm = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await renderDialog({ onConfirm, updateSettings })

    await act(async () => {
      getCheckbox().click()
    })
    await act(async () => {
      getButton('Close').click()
    })

    expect(updateSettings).toHaveBeenCalledWith({ confirmClosePinnedTab: false })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not persist the checkbox on cancel and resets it for the next request', async () => {
    const firstOnConfirm = vi.fn()
    const secondOnConfirm = vi.fn()
    const onCancel = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await renderDialog({ onConfirm: firstOnConfirm, onCancel, updateSettings })

    await act(async () => {
      getCheckbox().click()
    })
    await act(async () => {
      getButton('Cancel').click()
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(firstOnConfirm).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()

    await act(async () => {
      useAppStore.getState().requestPinnedTabCloseConfirm({
        tabLabel: 'Console',
        onConfirm: secondOnConfirm
      })
    })

    expect(getCheckbox().getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      getButton('Close').click()
    })

    expect(updateSettings).not.toHaveBeenCalled()
    expect(secondOnConfirm).toHaveBeenCalledTimes(1)
  })
})

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenInMenuSetting } from './OpenInMenuSetting'

const zed = { id: 'zed', label: 'Zed', command: 'zed' }
const cursor = { id: 'cursor', label: 'Cursor', command: 'cursor' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderSetting(
  fileExplorerApplicationId: string | null | undefined,
  updateSettings = vi.fn()
): ReturnType<typeof vi.fn> {
  act(() => {
    root.render(
      <OpenInMenuSetting
        applications={[zed, cursor]}
        fileExplorerApplicationId={fileExplorerApplicationId}
        updateSettings={updateSettings}
      />
    )
  })
  return updateSettings
}

function removeApp(label: string): void {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove app"]')
  ].find((candidate) => candidate.closest('.py-3')?.textContent?.includes(label))
  if (!button) {
    throw new Error(`Remove button not found: ${label}`)
  }
  act(() => button.click())
}

function chosenAppLabel(): string | undefined {
  return container.querySelector('[data-slot="select-trigger"]')?.textContent?.trim()
}

describe('OpenInMenuSetting File Explorer app', () => {
  it('shows the chosen app, and the Orca editor when none or a removed one is chosen', () => {
    renderSetting('zed')
    expect(chosenAppLabel()).toBe('Zed')

    renderSetting(null)
    expect(chosenAppLabel()).toBe('Orca editor')

    renderSetting('removed-app')
    expect(chosenAppLabel()).toBe('Orca editor')
  })

  it('returns to the Orca editor when the chosen app is removed', () => {
    const updateSettings = renderSetting('zed')

    removeApp('Zed')

    expect(updateSettings).toHaveBeenCalledWith({
      openInApplications: [cursor],
      fileExplorerOpenInApplicationId: null
    })
  })

  it('keeps the choice when another app is removed', () => {
    const updateSettings = renderSetting('zed')

    removeApp('Cursor')

    expect(updateSettings).toHaveBeenCalledWith({ openInApplications: [zed] })
  })
})

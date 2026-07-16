// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUsePermissionStatusResult } from '../../../../shared/computer-use-permissions-types'
import { ComputerUsePane } from './ComputerUsePane'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn<() => Promise<ComputerUsePermissionStatusResult>>(),
  openSetup: vi.fn()
}))

vi.mock('./ComputerUseSkillSetupPanel', () => ({
  ComputerUseSkillSetupPanel: () => null
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), message: vi.fn() }
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  mocks.getStatus.mockReset()
  mocks.openSetup.mockReset()
  mocks.getStatus.mockReturnValue(new Promise(() => {}))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      computerUsePermissions: {
        getStatus: mocks.getStatus,
        openSetup: mocks.openSetup,
        reset: vi.fn()
      }
    }
  })
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
})

describe('ComputerUsePane', () => {
  it('does not open setup while helper availability is loading', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<ComputerUsePane />))

    const openButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Open'
    )
    expect(openButton).toBeDefined()
    expect(openButton?.disabled).toBe(true)

    // Exercise the handler guard independently of the visual disabled state.
    openButton?.removeAttribute('disabled')
    await act(async () => openButton?.click())

    expect(mocks.getStatus).toHaveBeenCalledOnce()
    expect(mocks.openSetup).not.toHaveBeenCalled()
  })

  it('keeps setup closed when helper status could not be determined', async () => {
    mocks.getStatus.mockRejectedValue(new Error('status unavailable'))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<ComputerUsePane />))

    const openButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Open'
    )
    expect(openButton?.disabled).toBe(true)

    openButton?.removeAttribute('disabled')
    await act(async () => openButton?.click())

    expect(mocks.openSetup).not.toHaveBeenCalled()
  })
})

// @vitest-environment happy-dom

/**
 * The "Except default branch" exemption only bites during the "Hide sleeping"
 * sweep, so its row must stay out of the filter list until the parent row is on.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

import SidebarWorkspaceFilterSection from './SidebarWorkspaceFilterSection'

const EXEMPTION_LABEL = 'Except default branch'

function setState(overrides: Record<string, unknown> = {}): void {
  mocks.state = {
    showSleepingWorkspaces: true,
    setShowSleepingWorkspaces: vi.fn(),
    hideDefaultBranchWorkspace: false,
    setHideDefaultBranchWorkspace: vi.fn(),
    hideAutomationGeneratedWorkspaces: false,
    setHideAutomationGeneratedWorkspaces: vi.fn(),
    hideCliCreatedWorkspaces: false,
    setHideCliCreatedWorkspaces: vi.fn(),
    hideDetachedHeadWorkspaces: false,
    setHideDetachedHeadWorkspaces: vi.fn(),
    alwaysShowDefaultBranchWorkspace: true,
    setAlwaysShowDefaultBranchWorkspace: vi.fn(),
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<SidebarWorkspaceFilterSection />)
  })
}

function rowLabels(): string[] {
  return Array.from(container.querySelectorAll('[role="switch"]')).map(
    (el) => el.textContent?.trim() ?? ''
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SidebarWorkspaceFilterSection', () => {
  it('hides the default-branch exemption row while sleeping workspaces are shown', () => {
    setState({ showSleepingWorkspaces: true })
    render()
    expect(rowLabels()).not.toContain(EXEMPTION_LABEL)
  })

  it('shows the exemption row once "Hide sleeping" is ticked', () => {
    setState({ showSleepingWorkspaces: false })
    render()
    expect(rowLabels()).toContain(EXEMPTION_LABEL)
  })

  it('keeps the exemption row hidden even when it is switched off', () => {
    setState({ showSleepingWorkspaces: true, alwaysShowDefaultBranchWorkspace: false })
    render()
    expect(rowLabels()).not.toContain(EXEMPTION_LABEL)
  })
})

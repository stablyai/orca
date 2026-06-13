// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings, Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  openTaskPage: vi.fn(),
  openAutomationsPage: vi.fn(),
  openActivityPage: vi.fn(),
  openMobilePage: vi.fn(),
  openModal: vi.fn(),
  updateSettings: vi.fn(),
  refreshPreflightStatus: vi.fn(),
  checkLinearConnection: vi.fn(),
  dismissMobileOnboardingBadge: vi.fn(),
  setSetupGuideSidebarDismissed: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/store/selectors', () => ({
  useRepoMap: () =>
    new Map(
      ((mocks.state.repos as Repo[] | undefined) ?? []).map((repo) => [repo.id, repo] as const)
    )
}))

vi.mock('@/components/activity/useActivityUnreadCount', () => ({
  useActivityUnreadCount: () => 0
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘P'
}))

vi.mock('./mobile-sidebar-onboarding-badge', () => ({
  useMobileSidebarOnboardingBadge: () => ({
    visible: false,
    dismiss: mocks.dismissMobileOnboardingBadge
  })
}))

vi.mock('../setup-guide/use-setup-guide-progress', () => ({
  useSetupGuideProgress: () => ({
    ready: true,
    coreDoneCount: 0,
    coreTotal: 1,
    stepDone: {}
  })
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  )
}))

import {
  getSetupGuideSidebarEntryReady,
  shouldShowAgentsButton,
  shouldShowAutomationsButton,
  shouldShowMobileButton,
  shouldShowSetupGuideEntry
} from './SidebarNav'
import SidebarNav from './SidebarNav'

function gitRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo-1',
    displayName: 'repo-1',
    badgeColor: 'gray',
    addedAt: 1,
    kind: 'git'
  }
}

function folderRepo(): Repo {
  return {
    id: 'folder-1',
    path: '/tmp/folder-1',
    displayName: 'folder-1',
    badgeColor: 'gray',
    addedAt: 1,
    kind: 'folder'
  }
}

function setSidebarState({
  settings = getDefaultSettings('/tmp'),
  repos = [gitRepo()]
}: {
  settings?: GlobalSettings
  repos?: Repo[]
} = {}): void {
  mocks.state = {
    settings,
    repos,
    activeView: 'worktrees',
    openTaskPage: mocks.openTaskPage,
    openAutomationsPage: mocks.openAutomationsPage,
    openActivityPage: mocks.openActivityPage,
    openMobilePage: mocks.openMobilePage,
    openModal: mocks.openModal,
    updateSettings: mocks.updateSettings,
    preflightStatus: { glab: { installed: false } },
    preflightStatusChecked: true,
    refreshPreflightStatus: mocks.refreshPreflightStatus,
    linearStatus: { connected: false },
    linearStatusChecked: true,
    checkLinearConnection: mocks.checkLinearConnection,
    prefetchWorkItems: vi.fn(),
    activeRepoId: null,
    persistedUIReady: true,
    activeModal: null,
    setupGuideSidebarDismissed: true,
    setSetupGuideSidebarDismissed: mocks.setSetupGuideSidebarDismissed
  }
}

const mountedRoots: Root[] = []

async function renderSidebarNav(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<SidebarNav />)
  })
  return container
}

function queryButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === text
    ) ?? null
  )
}

function getButtonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = queryButtonByText(container, text)
  if (!button) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

function getHideButton(menu: Element): HTMLButtonElement {
  const button =
    Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).find((candidate) =>
      candidate.textContent?.includes('Hide from sidebar')
    ) ?? null
  if (!button) {
    throw new Error('Hide from sidebar button not found')
  }
  return button
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('SidebarNav', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    vi.clearAllMocks()
    setSidebarState()
  })

  it('hides the Agents entry while settings are loading', () => {
    expect(shouldShowAgentsButton(null)).toBe(false)
  })

  it('hides the Agents entry while the experimental Agents view is off', () => {
    expect(
      shouldShowAgentsButton({
        ...getDefaultSettings('/tmp'),
        experimentalActivity: false
      })
    ).toBe(false)
  })

  it('shows the Agents entry when the experimental Agents view is on', () => {
    expect(
      shouldShowAgentsButton({
        ...getDefaultSettings('/tmp'),
        experimentalActivity: true
      })
    ).toBe(true)
  })

  it('shows the Mobile entry by default for older settings', () => {
    expect(shouldShowMobileButton(null)).toBe(true)
    expect(shouldShowMobileButton({})).toBe(true)
  })

  it('hides the Mobile entry when the sidebar setting is off', () => {
    expect(shouldShowMobileButton({ showMobileButton: false })).toBe(false)
  })

  it('shows the Automations entry by default for older settings', () => {
    expect(shouldShowAutomationsButton(null)).toBe(true)
    expect(shouldShowAutomationsButton({})).toBe(true)
  })

  it('hides the Automations entry when the sidebar setting is off', () => {
    expect(shouldShowAutomationsButton({ showAutomationsButton: false })).toBe(false)
  })

  it('omits the Automations row when the sidebar setting is off', async () => {
    setSidebarState({
      settings: {
        ...getDefaultSettings('/tmp'),
        showAutomationsButton: false
      }
    })

    const container = await renderSidebarNav()

    expect(queryButtonByText(container, 'Automations')).toBeNull()
  })

  it('hides Automations from its sidebar context menu', async () => {
    const container = await renderSidebarNav()

    const automationsMenu = getButtonByText(container, 'Automations').closest(
      '[data-testid="context-menu"]'
    )
    expect(automationsMenu).not.toBeNull()

    await clickButton(getHideButton(automationsMenu as HTMLElement))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showAutomationsButton: false })
  })

  it('hides Mobile from its sidebar context menu', async () => {
    const container = await renderSidebarNav()

    const mobileMenu = getButtonByText(container, 'Orca Mobile').closest(
      '[data-testid="context-menu"]'
    )
    expect(mobileMenu).not.toBeNull()

    await clickButton(getHideButton(mobileMenu as HTMLElement))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showMobileButton: false })
  })

  it('hides task source shortcuts until the Tasks row is hovered or focused', async () => {
    const container = await renderSidebarNav()

    const tasksButton = getButtonByText(container, 'Tasks')
    const shortcuts = tasksButton.querySelector('[aria-label="Open GitHub tasks"]')?.parentElement

    expect(shortcuts?.className).toContain('hidden')
    expect(shortcuts?.className).toContain('group-hover:flex')
    expect(shortcuts?.className).toContain('group-focus-within:flex')
  })

  it('hides available Tasks from its sidebar context menu', async () => {
    const container = await renderSidebarNav()

    const tasksButton = getButtonByText(container, 'Tasks')
    expect(tasksButton.getAttribute('aria-disabled')).toBe('false')

    const tasksMenu = tasksButton.closest('[data-testid="context-menu"]')
    expect(tasksMenu).not.toBeNull()
    await clickButton(getHideButton(tasksMenu as HTMLElement))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showTasksButton: false })
  })

  it('keeps unavailable Tasks context-menu-capable while left click remains inert', async () => {
    setSidebarState({ repos: [folderRepo()] })
    const container = await renderSidebarNav()

    const tasksButton = getButtonByText(container, 'Tasks')
    expect(tasksButton.getAttribute('aria-disabled')).toBe('true')
    expect(tasksButton.disabled).toBe(false)
    expect(tasksButton.querySelectorAll('[role="button"]')).toHaveLength(0)
    expect(tasksButton.querySelector('[aria-label="Open GitHub tasks"]')).toBeNull()

    await clickButton(tasksButton)
    expect(mocks.openTaskPage).not.toHaveBeenCalled()

    const tasksMenu = tasksButton.closest('[data-testid="context-menu"]')
    expect(tasksMenu).not.toBeNull()
    await clickButton(getHideButton(tasksMenu as HTMLElement))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showTasksButton: false })
  })

  it('shows the setup guide entry only after readiness, before completion, and before explicit hide', () => {
    expect(
      shouldShowSetupGuideEntry({ ready: false, setupComplete: false, dismissed: false })
    ).toBe(false)
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: false, dismissed: false })).toBe(
      true
    )
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: true, dismissed: false })).toBe(
      false
    )
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: false, dismissed: true })).toBe(
      false
    )
  })

  it('requires both persisted UI and setup progress readiness before showing setup guide entry', () => {
    expect(getSetupGuideSidebarEntryReady(false, true)).toBe(false)
    expect(getSetupGuideSidebarEntryReady(true, false)).toBe(false)
    expect(getSetupGuideSidebarEntryReady(true, true)).toBe(true)
  })
})

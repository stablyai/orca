// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'
import { SetupGuideSidebarEntry } from './SetupGuideSidebarEntry'

const mocks = vi.hoisted(() => ({
  useSetupGuideProgress: vi.fn(),
  openModal: vi.fn(),
  setSetupGuideSidebarDismissed: vi.fn()
}))

let persistedUIReady = true
let activeModal = 'none'
let setupGuideSidebarDismissed = false

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeModal,
      openModal: mocks.openModal,
      persistedUIReady,
      setupGuideSidebarDismissed,
      setSetupGuideSidebarDismissed: mocks.setSetupGuideSidebarDismissed
    })
}))

vi.mock('../setup-guide/use-setup-guide-progress', () => ({
  useSetupGuideProgress: mocks.useSetupGuideProgress
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('../setup-guide/SetupGuideProgressRing', () => ({
  SetupGuideProgressRing: () => <span data-testid="setup-progress-ring" />
}))

function makeProgress(overrides: Partial<FeatureWallSetupProgress> = {}): FeatureWallSetupProgress {
  return {
    ready: true,
    stepDone: {
      'default-agent': false,
      'add-two-repos': false,
      notifications: false,
      'split-terminal': false,
      'two-worktrees': false,
      browser: false,
      'task-sources': false,
      'agent-capabilities': false,
      'setup-script': false
    },
    coreDoneCount: 0,
    coreTotal: 9,
    ...overrides
  }
}

function makeAllDoneProgress(
  overrides: Partial<FeatureWallSetupProgress> = {}
): FeatureWallSetupProgress {
  return makeProgress({
    stepDone: {
      'default-agent': true,
      'add-two-repos': true,
      notifications: true,
      'split-terminal': true,
      'two-worktrees': true,
      browser: true,
      'task-sources': true,
      'agent-capabilities': true,
      'setup-script': true
    },
    coreDoneCount: 9,
    coreTotal: 9,
    ...overrides
  })
}

function makeOnlyBrowserIncompleteProgress(): FeatureWallSetupProgress {
  return makeAllDoneProgress({
    stepDone: {
      ...makeAllDoneProgress().stepDone,
      browser: false
    },
    coreDoneCount: 8,
    coreTotal: 9
  })
}

const mountedRoots: Root[] = []

async function renderSetupGuideSidebarEntry(): Promise<{
  container: HTMLDivElement
  rerender: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  const rerender = async (): Promise<void> => {
    await act(async () => {
      root.render(<SetupGuideSidebarEntry />)
    })
  }
  await rerender()
  return { container, rerender }
}

describe('SetupGuideSidebarEntry', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    persistedUIReady = true
    activeModal = 'none'
    setupGuideSidebarDismissed = false
    mocks.openModal.mockReset()
    mocks.setSetupGuideSidebarDismissed.mockReset()
    mocks.useSetupGuideProgress.mockReturnValue(makeProgress())
  })

  it('does not render before persisted UI hydration is ready', () => {
    persistedUIReady = false

    expect(renderToStaticMarkup(<SetupGuideSidebarEntry />)).not.toContain('Onboarding checklist')
  })

  it('does not render before setup progress readiness settles', () => {
    mocks.useSetupGuideProgress.mockReturnValue(makeProgress({ ready: false }))

    expect(renderToStaticMarkup(<SetupGuideSidebarEntry />)).not.toContain('Onboarding checklist')
  })

  it('does not flash when agent capability completion is still unresolved', () => {
    mocks.useSetupGuideProgress.mockReturnValue(
      makeAllDoneProgress({
        ready: false,
        stepDone: {
          ...makeAllDoneProgress().stepDone,
          'agent-capabilities': false
        },
        coreDoneCount: 7
      })
    )

    expect(renderToStaticMarkup(<SetupGuideSidebarEntry />)).not.toContain('Onboarding checklist')
  })

  it('does not render after setup is complete and progress is ready', () => {
    mocks.useSetupGuideProgress.mockReturnValue(makeAllDoneProgress())

    expect(renderToStaticMarkup(<SetupGuideSidebarEntry />)).not.toContain('Onboarding checklist')
  })

  it('renders for fresh active users when only the browser step is incomplete', () => {
    mocks.useSetupGuideProgress.mockReturnValue(makeOnlyBrowserIncompleteProgress())

    expect(renderToStaticMarkup(<SetupGuideSidebarEntry />)).toContain('Onboarding checklist')
  })

  it('does not render when the sidebar entry was dismissed with only browser incomplete', () => {
    mocks.useSetupGuideProgress.mockReturnValue(makeOnlyBrowserIncompleteProgress())
    setupGuideSidebarDismissed = true

    expect(renderToStaticMarkup(<SetupGuideSidebarEntry />)).not.toContain('Onboarding checklist')
  })

  it('renders after persisted UI and setup progress are ready when setup is incomplete', () => {
    expect(renderToStaticMarkup(<SetupGuideSidebarEntry />)).toContain('Onboarding checklist')
  })

  it('keeps the visible entry mounted during transient setup progress refreshes', async () => {
    const { container, rerender } = await renderSetupGuideSidebarEntry()

    expect(container.textContent).toContain('Onboarding checklist')

    mocks.useSetupGuideProgress.mockReturnValue(makeProgress({ ready: false }))
    await rerender()

    expect(container.textContent).toContain('Onboarding checklist')

    mocks.useSetupGuideProgress.mockReturnValue(makeAllDoneProgress())
    await rerender()

    expect(container.textContent).not.toContain('Onboarding checklist')
  })
})

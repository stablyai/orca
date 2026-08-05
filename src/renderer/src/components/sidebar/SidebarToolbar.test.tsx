// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { i18n } from '@/i18n/i18n'
import ko from '@/i18n/locales/ko.json'
import SidebarToolbar from './SidebarToolbar'

const mocks = vi.hoisted(() => ({
  activeTooltipOpen: false,
  state: {
    persistedUIReady: true,
    featureInteractions: {}
  } as Partial<AppState>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children, open }: { children: ReactNode; open?: boolean }) => {
    mocks.activeTooltipOpen = open === true
    return <>{children}</>
  },
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) =>
    mocks.activeTooltipOpen ? <span>{children}</span> : null
}))

vi.mock('./ScrollToCurrentWorkspaceToolbarButton', () => ({
  ScrollToCurrentWorkspaceToolbarButton: () => <button type="button">Current workspace</button>
}))

vi.mock('./SidebarSettingsHelpMenu', () => ({
  SidebarSettingsHelpMenu: () => <button type="button">Settings</button>
}))

vi.mock('../orca-profiles/OrcaProfileSwitcher', () => ({
  OrcaProfileSwitcher: ({ placement }: { placement?: string }) => (
    <button type="button" data-placement={placement}>
      Profile
    </button>
  )
}))

const roots: Root[] = []

async function renderToolbar(onWorkspaceBoardToggle = vi.fn()): Promise<{
  container: HTMLDivElement
  rerender: () => Promise<void>
  onWorkspaceBoardToggle: ReturnType<typeof vi.fn>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(
        <SidebarToolbar
          workspaceBoardOpen={false}
          onWorkspaceBoardToggle={onWorkspaceBoardToggle}
        />
      )
    })
  }
  await render()

  return { container, rerender: render, onWorkspaceBoardToggle }
}

describe('SidebarToolbar moved workspace board hint', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.localStorage.clear()
    mocks.activeTooltipOpen = false
    mocks.state = {
      persistedUIReady: true,
      featureInteractions: {}
    }
  })

  afterEach(async () => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.clearAllMocks()
    // Why: the language-change case mutates the shared i18n instance; restore
    // here so a failing assertion cannot leave later tests running in Korean.
    await i18n.changeLanguage('en')
  })

  it('does not show the moved hint to brand-new users after their first board click', async () => {
    const onWorkspaceBoardToggle = vi.fn(() => {
      mocks.state = {
        ...mocks.state,
        featureInteractions: {
          'workspace-board': { firstInteractedAt: Date.now(), interactionCount: 1 }
        }
      }
    })
    const { container, rerender } = await renderToolbar(onWorkspaceBoardToggle)

    expect(container.textContent).not.toContain('Workspace board moved to the bottom bar')

    const boardButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Workspace board"]'
    )
    expect(boardButton).not.toBeNull()
    await act(async () => {
      boardButton?.click()
    })
    await rerender()

    expect(onWorkspaceBoardToggle).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('Workspace board moved to the bottom bar')
    expect(window.localStorage.getItem('orca.workspaceBoardMovedHintSeen.v1')).toBeNull()
  })

  it('shows the moved hint once to users who had already used the workspace board', async () => {
    mocks.state = {
      persistedUIReady: true,
      featureInteractions: {
        'workspace-board': { firstInteractedAt: 100, interactionCount: 2 }
      }
    }

    const { container } = await renderToolbar()

    expect(container.textContent).toContain('Workspace board moved to the bottom bar')
    expect(window.localStorage.getItem('orca.workspaceBoardMovedHintSeen.v1')).toBe('true')
  })

  // Why: the toolbar is a React.memo boundary whose props never change on a
  // language switch, so without its own useTranslation() subscription it keeps
  // the English copy it rendered at boot (the persisted locale is applied
  // asynchronously, after the lazy catalog loads).
  it('relabels itself when the UI language changes after mount', async () => {
    const { container } = await renderToolbar()
    expect(container.querySelector('button[aria-label="Workspace board"]')).not.toBeNull()

    await act(async () => {
      await i18n.changeLanguage('ko')
    })

    // Why: read the expected copy from the catalog instead of hardcoding it, so
    // editing the Korean wording cannot fail this test as a bogus stale-render
    // report.
    const localized = ko.auto.components.sidebar.SidebarToolbar['49f62c5665']
    expect(localized).not.toBe('Workspace board')
    expect(container.querySelector(`button[aria-label="${localized}"]`)).not.toBeNull()
  })

  it('renders the profile switcher before settings in the footer controls', async () => {
    const { container } = await renderToolbar()
    const html = container.innerHTML

    expect(html).toContain('data-placement="sidebar"')
    expect(html.indexOf('Profile')).toBeLessThan(html.indexOf('Settings'))
  })
})

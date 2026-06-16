import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarSettingsHelpMenu } from './SidebarSettingsHelpMenu'

const mocks = vi.hoisted(() => ({
  openModal: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  appRestart: vi.fn(),
  updaterCheck: vi.fn(),
  shellOpenUrl: vi.fn(),
  useShortcutKeys: vi.fn(),
  setupProgress: {
    ready: true,
    coreDoneCount: 2,
    coreTotal: 5,
    stepDone: {}
  }
}))

let updateStatus = { state: 'idle' } as const

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openModal: mocks.openModal,
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget,
      updateStatus
    })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeys: mocks.useShortcutKeys
}))

vi.mock('@/hooks/useMountedRef', () => ({
  useMountedRef: () => ({ current: true })
}))

vi.mock('../onboarding/show-onboarding-event', () => ({
  showOnboardingFromRenderer: vi.fn()
}))

vi.mock('../setup-guide/use-setup-guide-progress', () => ({
  useSetupGuideProgress: () => mocks.setupProgress
}))

vi.mock('../setup-guide/SetupGuideProgressRing', () => ({
  SetupGuideProgressRing: () => <span data-testid="setup-guide-progress-ring" />
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button data-testid="menu-item" onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    'aria-label': ariaLabel
  }: {
    children: ReactNode
    onClick?: (event: React.MouseEvent) => void
    'aria-label'?: string
  }) => (
    <button data-testid="trigger-button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  )
}))

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('./SidebarFeedbackDialog', () => ({
  SidebarFeedbackDialog: () => <div data-testid="feedback-dialog" />
}))

describe('SidebarSettingsHelpMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useShortcutKeys.mockReturnValue(['⌘', ','])
    updateStatus = { state: 'idle' }
    mocks.setupProgress = {
      ready: true,
      coreDoneCount: 2,
      coreTotal: 5,
      stepDone: {}
    }
  })

  it('renders the help button with correct aria-label', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Help')
  })

  it('renders the settings button with correct aria-label', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('aria-label="Settings"')
  })

  it('renders the settings button before the help button', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    const settingsIndex = html.indexOf('lucide-settings')
    const helpIndex = html.indexOf('lucide-circle-question-mark')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    expect(helpIndex).toBeGreaterThan(settingsIndex)
  })

  it('renders Send Feedback menu item', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Send Feedback')
  })

  it('renders Keyboard Shortcuts menu item', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Keyboard Shortcuts')
  })

  it('renders Milestones with progress when setup is incomplete', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Milestones')
    expect(html).toContain('data-testid="setup-guide-progress-ring"')
  })

  it('hides Milestones when setup is complete', () => {
    mocks.setupProgress = {
      ready: true,
      coreDoneCount: 5,
      coreTotal: 5,
      stepDone: {}
    }
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).not.toContain('Milestones')
  })

  it('hides the Onboarding admin entry by default', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).not.toContain('Onboarding')
  })

  it('renders Docs link', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Docs')
  })

  it('renders Changelog link', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Changelog')
  })

  it('renders GitHub link', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('GitHub')
  })

  it('renders Discord link', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Discord')
  })

  it('renders X link', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('>X<')
  })

  it('renders Check for Updates menu item', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Check for Updates')
  })

  it('renders shortcut keys in the settings tooltip', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('⌘')
    expect(html).toContain('>,</span>')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarSettingsHelpMenu } from './SidebarSettingsHelpMenu'

const mocks = vi.hoisted(() => ({
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  appRestart: vi.fn(),
  updaterCheck: vi.fn(),
  shellOpenUrl: vi.fn(),
  useShortcutLabel: vi.fn()
}))

let updateStatus = { state: 'idle' } as const

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget,
      updateStatus
    })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: mocks.useShortcutLabel
}))

vi.mock('@/hooks/useMountedRef', () => ({
  useMountedRef: () => ({ current: true })
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
    onClick
  }: {
    children: ReactNode
    onClick?: (event: React.MouseEvent) => void
  }) => (
    <button data-testid="trigger-button" onClick={onClick}>
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
    mocks.useShortcutLabel.mockReturnValue('⌘,')
    updateStatus = { state: 'idle' }
  })

  it('renders the help button with correct aria-label', () => {
    updateStatus = { state: 'idle' }
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Help')
  })

  it('renders Settings menu item', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Settings')
  })

  it('renders Send Feedback menu item', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Send Feedback')
  })

  it('renders Keyboard Shortcuts menu item', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Keyboard Shortcuts')
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

  it('renders Check for Updates menu item', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('Check for Updates')
  })

  it('renders shortcut label next to Settings', () => {
    const html = renderToStaticMarkup(<SidebarSettingsHelpMenu />)
    expect(html).toContain('⌘,')
  })
})

// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentDashboardTerminalEscape } from '../../../../shared/ui-chrome-types'

const updateSettings = vi.fn()
const menuState = vi.hoisted((): { terminalEscape: AgentDashboardTerminalEscape | undefined } => ({
  terminalEscape: undefined
}))

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      settings: {
        experimentalAgentDashboardMode: 'in-window'
        experimentalAgentDashboardShowIdle: boolean
        experimentalAgentDashboardTerminalEscape: AgentDashboardTerminalEscape | undefined
      }
      updateSettings: typeof updateSettings
    }) => unknown
  ) =>
    selector({
      settings: {
        experimentalAgentDashboardMode: 'in-window',
        experimentalAgentDashboardShowIdle: false,
        experimentalAgentDashboardTerminalEscape: menuState.terminalEscape
      },
      updateSettings
    })
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { AgentDashboardSettingsMenu } from './AgentDashboardSettingsMenu'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  updateSettings.mockReset()
  menuState.terminalEscape = undefined
})

function renderMenu(): HTMLDivElement {
  const host = document.createElement('div')
  container = host
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(<AgentDashboardSettingsMenu onSwitchToPopout={vi.fn()} onOpenChange={vi.fn()} />)
  })
  return host
}

const ESCAPE_SWITCH = 'button[role="switch"][aria-label="Close terminal view with Esc"]'

describe('AgentDashboardSettingsMenu', () => {
  it('owns the idle-agent visibility setting', () => {
    const host = renderMenu()

    const toggle = host.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Show idle agents"]'
    )
    expect(toggle).not.toBeNull()

    act(() => toggle?.click())

    expect(updateSettings).toHaveBeenCalledWith({ experimentalAgentDashboardShowIdle: true })
  })

  it('turns on Esc-closes-terminal from the gear', () => {
    const toggle = renderMenu().querySelector<HTMLButtonElement>(ESCAPE_SWITCH)
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-checked')).toBe('false')

    act(() => toggle?.click())

    expect(updateSettings).toHaveBeenCalledWith({
      experimentalAgentDashboardTerminalEscape: 'close-dialog'
    })
  })

  it('turns Esc-closes-terminal back off', () => {
    menuState.terminalEscape = 'close-dialog'
    const toggle = renderMenu().querySelector<HTMLButtonElement>(ESCAPE_SWITCH)
    expect(toggle?.getAttribute('aria-checked')).toBe('true')

    act(() => toggle?.click())

    expect(updateSettings).toHaveBeenCalledWith({
      experimentalAgentDashboardTerminalEscape: 'send-to-agent'
    })
  })
})

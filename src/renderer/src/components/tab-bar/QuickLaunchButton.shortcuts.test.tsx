// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ProjectedAgentMenuItems } from './QuickLaunchButton'
import type { NewTabAgentMenuModel } from './use-new-tab-agent-menu-rows'

const initialState = useAppStore.getState()
const model: NewTabAgentMenuModel = {
  state: 'settled',
  rows: [
    { kind: 'terminal', agent: 'claude', executionHostId: 'local' },
    { kind: 'terminal', agent: 'codex', executionHostId: 'local' },
    { kind: 'terminal', agent: 'gemini', executionHostId: 'local' }
  ],
  detection: {
    detectedIds: ['claude', 'codex', 'gemini'],
    detectionFailed: false,
    needsServerUpdate: false,
    isLoading: false,
    isRefreshing: false,
    refresh: async () => ['claude', 'codex', 'gemini']
  }
}

function Menu({ menuModel = model }: { menuModel?: NewTabAgentMenuModel }) {
  return (
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Agents</DropdownMenuTrigger>
      <DropdownMenuContent>
        <ProjectedAgentMenuItems model={menuModel} runLaunch={vi.fn()} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function shortcut(label: string): string | null {
  return (
    screen
      .getByTitle(`Launch ${label} in a new terminal`)
      .querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? null
  )
}

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/test'), defaultTuiAgent: 'claude' },
    keybindings: { 'tab.newAgent': ['Mod+Alt+T'] }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})

describe('agent menu shortcut labels', () => {
  it.each([
    ['Mac', '⌘⇧C, ⌘⌥C', '⌘⌥T'],
    ['Windows', 'Ctrl+Shift+C, Ctrl+Alt+C', 'Ctrl+Alt+T'],
    ['Linux', 'Ctrl+Shift+C, Ctrl+Alt+C', 'Ctrl+Alt+T']
  ])('shows per-agent bindings and the default fallback on %s', (platform, agent, common) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
    useAppStore.setState({
      keybindings: {
        'tab.newAgent': ['Mod+Alt+T'],
        'tab.newAgent.codex': ['Mod+Shift+C', 'Mod+Alt+C']
      }
    })

    render(<Menu />)

    expect(shortcut('Codex')).toBe(agent)
    expect(shortcut('Claude')).toBe(common)
    expect(shortcut('Gemini')).toBeNull()
    expect(screen.getByRole('menu').textContent).not.toContain('Unassigned')
  })

  it('updates mounted rows and lists both chords on the default agent', () => {
    render(<Menu />)
    expect(shortcut('Claude')).toBe('⌘⌥T')
    expect(shortcut('Codex')).toBeNull()

    act(() =>
      useAppStore.setState({
        keybindings: {
          'tab.newAgent': ['Mod+Alt+T'],
          'tab.newAgent.claude': ['Mod+Shift+K'],
          'tab.newAgent.codex': ['Mod+Shift+C']
        }
      })
    )
    expect(shortcut('Claude')).toBe('⌘⇧K, ⌘⌥T')
    expect(shortcut('Codex')).toBe('⌘⇧C')

    act(() =>
      useAppStore.setState({
        keybindings: { 'tab.newAgent': ['Mod+Alt+N'], 'tab.newAgent.claude': [] }
      })
    )
    expect(shortcut('Claude')).toBe('⌘⌥N')
    expect(shortcut('Codex')).toBeNull()

    act(() => useAppStore.setState({ keybindings: { 'tab.newAgent': [] } }))
    expect(shortcut('Claude')).toBeNull()
  })

  it('hides agent chords that an earlier match claims first', () => {
    useAppStore.setState({
      keybindings: {
        'tab.newAgent': ['Mod+Alt+T'],
        'tab.newAgent.claude': ['Mod+Shift+K'],
        'tab.newAgent.codex': ['Mod+Alt+T', 'Mod+Shift+K', 'Mod+Shift+C']
      }
    })
    render(<Menu />)

    expect(shortcut('Claude')).toBe('⌘⇧K, ⌘⌥T')
    expect(shortcut('Codex')).toBe('⌘⇧C')
  })

  it('keeps the fallback on the host-selected default as rows load and change', () => {
    const { rerender } = render(<Menu menuModel={{ state: 'loading', placeholderCount: 2 }} />)
    expect(screen.queryByTitle('Launch Codex in a new terminal')).toBeNull()

    rerender(<Menu menuModel={{ ...model, defaultTuiAgent: 'codex' }} />)
    expect(shortcut('Claude')).toBeNull()
    expect(shortcut('Codex')).toBe('⌘⌥T')

    rerender(<Menu menuModel={{ ...model, defaultTuiAgent: 'gemini' }} />)
    expect(shortcut('Codex')).toBeNull()
    expect(shortcut('Gemini')).toBe('⌘⌥T')
  })

  it.each([null, 'blank'] as const)(
    'shows only explicit agent bindings with a %s host default',
    (defaultTuiAgent) => {
      useAppStore.setState({
        keybindings: { 'tab.newAgent': ['Mod+Alt+T'], 'tab.newAgent.codex': ['Mod+Shift+C'] }
      })
      render(<Menu menuModel={{ ...model, defaultTuiAgent }} />)

      expect(shortcut('Claude')).toBeNull()
      expect(shortcut('Codex')).toBe('⌘⇧C')
      expect(shortcut('Gemini')).toBeNull()
    }
  )
})

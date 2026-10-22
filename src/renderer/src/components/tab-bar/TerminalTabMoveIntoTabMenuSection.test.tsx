/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  A,
  B,
  C,
  intoPaneState,
  SOURCE,
  sourceLayout,
  TARGET,
  targetLayout,
  terminalTab,
  WT
} from '../terminal-pane/terminal-tab-into-pane-fixture'
import type { TerminalTabIntoPaneState } from '../terminal-pane/terminal-tab-into-pane-eligibility'
import { TerminalTabMoveIntoTabMenuSection } from './TerminalTabMoveIntoTabMenuSection'

// The window-applied join under test exists only while the layout-owner switch is off.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const moveMock = vi.hoisted(() => vi.fn())
const storeMock = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state }
})

vi.mock('@/components/terminal-pane/terminal-tab-into-pane-deps', () => ({
  moveTerminalTabIntoPaneInApp: moveMock
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({
    children,
    disabled
  }: {
    children?: ReactNode
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => <span>{children}</span>
}))

vi.mock('lucide-react', () => ({
  Columns2: () => null,
  PanelBottomClose: () => null,
  PanelRightClose: () => null
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeMock.state)
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function render(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<TerminalTabMoveIntoTabMenuSection tabId={SOURCE} worktreeId={WT} />)
  })
  mounted.push({ container, root })
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`)
  }
  return found
}

const OTHER = 'tab-other'

function seedState(patch: Partial<TerminalTabIntoPaneState> = {}): void {
  moveMock.mockReset()
  for (const key of Object.keys(storeMock.state)) {
    delete storeMock.state[key]
  }
  Object.assign(
    storeMock.state,
    intoPaneState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, 'pty-a', { title: 'build' }),
          terminalTab(TARGET, 'pty-b', { title: 'server' }),
          terminalTab(OTHER, 'pty-o', { title: 'logs' })
        ],
        'repo1::/elsewhere': [
          terminalTab('tab-foreign', 'pty-f', { worktreeId: 'repo1::/elsewhere', title: 'foreign' })
        ]
      },
      terminalLayoutsByTabId: {
        [SOURCE]: sourceLayout(),
        [TARGET]: targetLayout(),
        [OTHER]: { ...sourceLayout(), root: { type: 'leaf', leafId: B } }
      },
      ...patch
    }),
    { tabBarOrderByWorktree: { [WT]: [SOURCE, OTHER, TARGET] } }
  )
}

beforeEach(() => seedState())

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('TerminalTabMoveIntoTabMenuSection', () => {
  it('lists the other terminal tabs of the same worktree in tab-bar order', () => {
    const container = render()

    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toContain('Move Into Tab')
    const logs = labels.findIndex((text) => text?.startsWith('logs'))
    const server = labels.findIndex((text) => text?.startsWith('server'))
    expect(logs).toBeGreaterThan(-1)
    expect(server).toBeGreaterThan(logs)
    expect(labels.some((text) => text?.startsWith('build'))).toBe(false)
    expect(labels.some((text) => text?.startsWith('foreign'))).toBe(false)
  })

  it('moves into the target active leaf on Split Right and Split Down', () => {
    const container = render()
    const serverEntry = button(container, 'server').parentElement

    if (!serverEntry) {
      throw new Error('Missing submenu wrapper')
    }
    act(() => button(serverEntry, 'Split Right').click())
    act(() => button(serverEntry, 'Split Down').click())

    expect(moveMock).toHaveBeenNthCalledWith(1, {
      sourceTabId: SOURCE,
      targetTabId: TARGET,
      targetLeafId: C,
      side: 'right'
    })
    expect(moveMock).toHaveBeenNthCalledWith(2, {
      sourceTabId: SOURCE,
      targetTabId: TARGET,
      targetLeafId: C,
      side: 'bottom'
    })
  })

  it('disables the Move Into Tab trigger itself, with the reason, when the source tab has several panes', () => {
    seedState({
      terminalLayoutsByTabId: { [SOURCE]: targetLayout(), [TARGET]: targetLayout() }
    })
    const container = render()

    const trigger = button(container, 'Move Into Tab')
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain('Tab has several panes')
    expect(container.textContent).not.toContain('server')
    expect(moveMock).not.toHaveBeenCalled()
  })

  it('disables the trigger for a sleeping source, and leaves it enabled when only a target refuses', () => {
    seedState({
      sleepingAgentSessionsByPaneKey: {
        [`${SOURCE}:${A}`]: {
          paneKey: `${SOURCE}:${A}`,
          tabId: SOURCE,
          worktreeId: WT,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })
    const sleeping = render()
    expect(button(sleeping, 'Move Into Tab').disabled).toBe(true)
    expect(button(sleeping, 'Move Into Tab').textContent).toContain('Pane is asleep')

    seedState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, 'pty-a', { title: 'build' }),
          terminalTab(TARGET, 'pty-b', { title: 'server', viewMode: 'chat' })
        ]
      }
    })
    const targetOnly = render()
    expect(button(targetOnly, 'Move Into Tab').disabled).toBe(false)
  })

  it('tells same-titled targets apart and moves the one that was picked', () => {
    seedState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, 'pty-a', { title: 'build' }),
          terminalTab(TARGET, 'pty-b', { title: 'server' }),
          terminalTab(OTHER, 'pty-o', { title: 'server' })
        ]
      }
    })
    const container = render()

    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels.filter((text) => text?.startsWith('server'))).toEqual([
      'server (1)',
      'server (2)'
    ])
    // Tab-bar order is SOURCE, OTHER, TARGET: the second "server" is TARGET.
    const second = button(container, 'server (2)').parentElement
    if (!second) {
      throw new Error('Missing submenu wrapper')
    }
    act(() => button(second, 'Split Right').click())
    expect(moveMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTabId: SOURCE, targetTabId: TARGET, side: 'right' })
    )
  })

  it('disables only the target that fails its own check', () => {
    seedState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, 'pty-a', { title: 'build' }),
          terminalTab(TARGET, 'pty-b', { title: 'server', viewMode: 'chat' }),
          terminalTab(OTHER, 'pty-o', { title: 'logs' })
        ]
      },
      terminalLayoutsByTabId: {
        [SOURCE]: sourceLayout(),
        [TARGET]: targetLayout(),
        [OTHER]: { ...sourceLayout(), root: { type: 'leaf', leafId: B } }
      }
    })
    const container = render()

    expect(button(container, 'server').disabled).toBe(true)
    expect(button(container, 'server').textContent).toContain('Chat view')
    expect(button(container, 'logs').disabled).toBe(false)
  })

  it('shows one disabled placeholder when there is no other terminal tab', () => {
    seedState({ tabsByWorktree: { [WT]: [terminalTab(SOURCE, 'pty-a')] } })
    const container = render()

    const placeholder = button(container, 'No other terminal tabs')
    expect(placeholder.disabled).toBe(true)
  })
})

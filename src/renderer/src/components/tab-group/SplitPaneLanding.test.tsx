// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

type AgentModel =
  | { state: 'loading'; placeholderCount: number }
  | { state: 'settled'; rows: { kind: 'terminal'; agent: 'codex' }[] }

// Why: agent rows and files arrive from subscriptions in the app, so the fakes push updates the same way.
const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const data: { agentModel: AgentModel; files: string[] } = {
    agentModel: { state: 'loading', placeholderCount: 0 },
    files: []
  }
  return {
    data,
    publish(next: Partial<typeof data>): void {
      Object.assign(data, next)
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    launchDefault: vi.fn(),
    launchRow: vi.fn()
  }
})

vi.mock('@/store/workspaces/selection/use-selected-worktree', () => ({
  useFileListWorktree: () => ({ path: '/repo' })
}))
vi.mock('@/components/quick-open-file-list', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useRuntimeFileListForWorktree: () => ({
      files: useSyncExternalStore(mocks.subscribe, () => mocks.data.files),
      loading: false,
      loadError: null
    })
  }
})
vi.mock('@/hooks/useAgentDetectionTarget', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAgentDetectionTargetForWorktree: () => undefined
}))
vi.mock('../tab-bar/use-new-tab-agent-menu-rows', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useNewTabAgentMenuRows: () => useSyncExternalStore(mocks.subscribe, () => mocks.data.agentModel)
  }
})
vi.mock('../tab-bar/QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: () => <div data-testid="agent-picker">Agent list</div>,
  useTabAgentMenuLaunch: () => mocks.launchRow
}))
vi.mock('../agent-tab-shortcut-launch', () => ({
  launchAgentTabShortcut: mocks.launchDefault
}))

import { SplitPaneLanding } from './SplitPaneLanding'

let host: HTMLDivElement
let root: Root

function render(): void {
  act(() =>
    root.render(<SplitPaneLanding worktreeId="wt" groupId="g" autoFocus onClosePane={undefined} />)
  )
}

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[cmdk-input]')!
}

function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string): boolean {
  let notPrevented = true
  act(() => {
    notPrevented = fireEvent.keyDown(document.activeElement ?? input(), {
      key
    })
  })
  return notPrevented
}

function highlighted(): string | null {
  return (
    document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value') ?? null
  )
}

function picker(): Element | null {
  return document.querySelector('[data-testid="agent-picker"]')
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.data.agentModel = { state: 'loading', placeholderCount: 0 }
  mocks.data.files = []
  useAppStore.setState(useAppStore.getInitialState(), true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SplitPaneLanding placeholder', () => {
  it.each([
    [260, 'Search'],
    [299, 'Search'],
    [300, 'Search agents and files'],
    [380, 'Search agents and files']
  ])('a %ipx card shows "%s"', (width, placeholder) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, width, 0)
    )
    render()

    expect(input().placeholder).toBe(placeholder)
    // The accessible name never shortens with the placeholder.
    expect(screen.getByRole('combobox', { name: 'Search agents and files' })).toBe(input())
  })
})

describe('SplitPaneLanding keyboard', () => {
  it('opens with the caret in the search field and launches the default agent on Enter', () => {
    render()

    expect(document.activeElement).toBe(input())
    expect(highlighted()).toBe('default-agent')
    press('Enter')
    expect(mocks.launchDefault).toHaveBeenCalledTimes(1)
    expect(mocks.launchDefault.mock.calls[0]?.[0]).toBe('wt')
  })

  it('opens the agent picker with → only from the default row with an empty query', async () => {
    render()

    press('ArrowDown')
    expect(highlighted()).toBe('terminal')
    press('ArrowRight')
    expect(picker()).toBeNull()

    press('ArrowUp')
    type(' ')
    expect(highlighted()).toBe('default-agent')
    expect(press('ArrowRight')).toBe(true)
    expect(picker()).toBeNull()

    type('')
    expect(highlighted()).toBe('default-agent')
    expect(press('ArrowRight')).toBe(false)
    expect(picker()).not.toBeNull()

    press('Escape')
    expect(picker()).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(input()))
  })

  it('clears the query on Esc and leaves an empty query alone', () => {
    render()

    type('term')
    expect(press('Escape')).toBe(false)
    expect(input().value).toBe('')
    expect(document.activeElement).toBe(input())

    expect(press('Escape')).toBe(true)
    expect(input().value).toBe('')
  })
})

describe('SplitPaneLanding late results', () => {
  it('highlights rows that arrive above an untouched highlight, so Enter opens them', () => {
    mocks.data.files = ['src/codea.ts', 'src/codeb.ts']
    render()
    type('co')
    press('ArrowDown')
    expect(highlighted()).toBe('file:src/codeb.ts')

    type('cod')
    expect(highlighted()).toBe('file:src/codea.ts')

    act(() =>
      mocks.publish({
        agentModel: {
          state: 'settled',
          rows: [{ kind: 'terminal', agent: 'codex' }]
        }
      })
    )
    expect(highlighted()).toBe('agent:terminal:codex')
    press('Enter')

    expect(mocks.launchRow).toHaveBeenCalledWith({
      kind: 'terminal',
      agent: 'codex'
    })
  })

  it('keeps a highlight the user moved when results change', () => {
    mocks.data.files = ['docs/mark-a.md']
    render()
    type('mark')
    press('ArrowDown')
    expect(highlighted()).toBe('file:docs/mark-a.md')

    act(() => mocks.publish({ files: ['docs/mark-b.md', 'docs/mark-a.md'] }))

    expect(highlighted()).toBe('file:docs/mark-a.md')
  })

  it('moves to the first row when the row the user moved to disappears, then follows late rows again', () => {
    mocks.data.files = ['src/codec.ts', 'src/codex-b.ts']
    render()
    type('cod')
    press('ArrowDown')
    expect(highlighted()).toBe('file:src/codex-b.ts')

    act(() => mocks.publish({ files: ['src/codec.ts'] }))
    expect(highlighted()).toBe('file:src/codec.ts')

    // The user's pick is gone, so rows that arrive above take the highlight as if it were untouched.
    act(() =>
      mocks.publish({
        agentModel: {
          state: 'settled',
          rows: [{ kind: 'terminal', agent: 'codex' }]
        }
      })
    )
    expect(highlighted()).toBe('agent:terminal:codex')
    press('Enter')
    expect(mocks.launchRow).toHaveBeenCalledWith({
      kind: 'terminal',
      agent: 'codex'
    })
  })
})

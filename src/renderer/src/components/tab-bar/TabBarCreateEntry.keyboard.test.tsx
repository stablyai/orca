// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabEntryOption } from './tab-create-entry-action'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'

// Why: the real entry-action module pulls in runtime IPC + the app store; the
// keyboard behavior under test only needs a controllable option list.
const entryOptionsMock = vi.hoisted(() => ({ options: [] as TabEntryOption[] }))
vi.mock('./tab-create-entry-action', () => ({
  getTabEntryOptions: () => entryOptionsMock.options
}))
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({ files: [], loading: false, loadError: null })
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [],
  AgentIcon: () => null
}))

import TabBarCreateEntry from './TabBarCreateEntry'

// Why: opt into React's act environment so state updates flush synchronously.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fileOption = (relativePath: string): TabEntryOption => ({
  id: `existing-file:${relativePath}`,
  classification: { kind: 'existing-file', matchKind: 'fuzzy', relativePath }
})

let container: HTMLDivElement
let root: Root

function mount(node: React.JSX.Element): void {
  act(() => {
    root.render(node)
  })
}

function pressKey(target: Element, key: string): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function setQuery(value: string): void {
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('input not found')
  }
  // Why: React patches the input value setter to track changes; bypass it with
  // the native setter so the synthetic onChange actually fires.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  act(() => {
    nativeSetter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

function submitForm(): void {
  const form = container.querySelector('form')
  if (!form) {
    throw new Error('form not found')
  }
  act(() => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  entryOptionsMock.options = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('TabBarCreateEntry keyboard navigation', () => {
  it('intercepts ArrowDown on a single-option list so it does not leak (guards >0 vs >1)', () => {
    entryOptionsMock.options = [fileOption('src/only-match.ts')]
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    mount(<TabBarCreateEntry worktreeId="wt" groupId="g" menuOpen onOpenEntry={onOpenEntry} />)

    // The pre-fix `> 1` guard left a single result unhandled: the arrow leaked to
    // the input cursor / Radix. Now it must be consumed (preventDefault) and Enter
    // still opens the row.
    const event = pressKey(container.querySelector('input')!, 'ArrowDown')
    expect(event.defaultPrevented).toBe(true)

    submitForm()
    expect(onOpenEntry).toHaveBeenCalledTimes(1)
    expect(onOpenEntry.mock.calls[0][0].classification).toMatchObject({
      kind: 'existing-file',
      relativePath: 'src/only-match.ts'
    })
  })

  it('iterates a multi-option result list with ArrowDown and selects the highlighted row', () => {
    entryOptionsMock.options = [fileOption('a.ts'), fileOption('b.ts'), fileOption('c.ts')]
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    mount(<TabBarCreateEntry worktreeId="wt" groupId="g" menuOpen onOpenEntry={onOpenEntry} />)

    const input = container.querySelector('input')!
    pressKey(input, 'ArrowDown')
    pressKey(input, 'ArrowDown')
    submitForm()

    expect(onOpenEntry.mock.calls[0][0].classification).toMatchObject({ relativePath: 'c.ts' })
  })

  it('wraps from the first row to the last with ArrowUp', () => {
    entryOptionsMock.options = [fileOption('a.ts'), fileOption('b.ts')]
    const onOpenEntry = vi.fn().mockResolvedValue(undefined)
    mount(<TabBarCreateEntry worktreeId="wt" groupId="g" menuOpen onOpenEntry={onOpenEntry} />)

    pressKey(container.querySelector('input')!, 'ArrowUp')
    submitForm()

    expect(onOpenEntry.mock.calls[0][0].classification).toMatchObject({ relativePath: 'b.ts' })
  })

  it('launches a matched agent when its highlighted row is selected', () => {
    const agentOptions: TabAgentLaunchOption[] = [
      { agent: 'gemini', aliases: ['gemini'], label: 'Gemini' }
    ]
    const onLaunchAgent = vi.fn()
    mount(
      <TabBarCreateEntry
        worktreeId="wt"
        groupId="g"
        menuOpen
        agentOptions={agentOptions}
        onOpenEntry={vi.fn().mockResolvedValue(undefined)}
        onLaunchAgent={onLaunchAgent}
      />
    )

    // A partial query surfaces the agent (issue #1); it is the top row, so Enter
    // launches it.
    setQuery('gem')
    submitForm()

    expect(onLaunchAgent).toHaveBeenCalledWith('gemini')
  })

  it('exposes the highlighted row to assistive tech via aria-activedescendant', () => {
    entryOptionsMock.options = [fileOption('a.ts'), fileOption('b.ts'), fileOption('c.ts')]
    mount(
      <TabBarCreateEntry
        worktreeId="wt"
        groupId="g"
        menuOpen
        onOpenEntry={vi.fn().mockResolvedValue(undefined)}
      />
    )

    const input = container.querySelector('input')!
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-activedescendant')).toBe('tab-create-entry-result-0')

    pressKey(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe('tab-create-entry-result-1')
    const active = document.getElementById('tab-create-entry-result-1')
    expect(active?.getAttribute('role')).toBe('option')
    expect(active?.getAttribute('aria-selected')).toBe('true')
  })

  it('routes ArrowDown into the enclosing menu when there are no result rows', () => {
    mount(
      <div role="menu">
        <TabBarCreateEntry worktreeId="wt" groupId="g" menuOpen onOpenEntry={vi.fn()} />
        <button type="button" role="menuitem">
          New Terminal
        </button>
        <button type="button" role="menuitem">
          Launch Claude
        </button>
      </div>
    )

    const firstItem = container.querySelector('[role="menuitem"]') as HTMLButtonElement
    pressKey(container.querySelector('input')!, 'ArrowDown')

    expect(document.activeElement).toBe(firstItem)
  })

  it('returns focus to the input on ArrowUp from the first menu item (no dead-end)', () => {
    mount(
      <div role="menu">
        <TabBarCreateEntry worktreeId="wt" groupId="g" menuOpen onOpenEntry={vi.fn()} />
        <button type="button" role="menuitem">
          New Terminal
        </button>
        <button type="button" role="menuitem">
          Launch Claude
        </button>
      </div>
    )

    const input = container.querySelector('input')!
    const firstItem = container.querySelector('[role="menuitem"]') as HTMLButtonElement
    act(() => firstItem.focus())
    expect(document.activeElement).toBe(firstItem)

    pressKey(firstItem, 'ArrowUp')
    expect(document.activeElement).toBe(input)
  })
})

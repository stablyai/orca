// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DebugBreakpointWire,
  DebugSnapshot,
  DebugStackFrameWire,
  DebugVariableWire
} from '../../../../preload/api/debug-api'
import { createDebugSessionStore, type DebugSessionStore } from '@/lib/debug/use-debug-session'
import type { DebugClient } from '@/lib/debug/debug-client'
import type { DebugSectionsClient } from './debug-section-contract'
import type { ComponentProps } from 'react'

const mocks = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return {
    store: create(() => ({
      worktreesByRepo: {
        repo1: [{ id: 'repo1::/real/a', repoId: 'repo1', path: '/real/a' }]
      },
      openFile: vi.fn(),
      setPendingEditorReveal: vi.fn()
    }))
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

vi.mock('@/store', () => ({ useAppStore: mocks.store }))

const { default: DebugPanelSections } = await import('./DebugPanelSections')

const WORKTREE = '/real/a'
const TARGET = { repoId: 'repo1', worktreePath: WORKTREE }
const FRAMES: DebugStackFrameWire[] = [
  {
    id: 10,
    name: 'main',
    source: { name: 'main.py', path: '/real/a/main.py' },
    line: 5,
    column: 1
  },
  {
    id: 12,
    name: 'helper',
    source: { name: 'lib.py', path: '/real/a/lib.py' },
    line: 7,
    column: 3
  },
  { id: 13, name: '<native>', line: 0, column: 0 }
]

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
const variable = (name: string, value: string, variablesReference = 0): DebugVariableWire => ({
  name,
  value,
  variablesReference
})

function snapshot(
  seq: number,
  overrides: Partial<DebugSnapshot> = {},
  worktreePath = WORKTREE
): DebugSnapshot {
  return {
    seq,
    worktreePath,
    status: 'stopped',
    configName: 'Run',
    adapterId: 'debugpy',
    capabilities: {},
    stopped: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true },
    threads: [{ id: 1, name: 'MainThread' }],
    breakpoints: [],
    exceptionFilters: { available: [], enabled: [] },
    lastError: null,
    ...overrides
  }
}

function fakeClient() {
  return {
    scopes: vi.fn<DebugSectionsClient['scopes']>(() =>
      ok([{ name: 'Locals', variablesReference: 100, expensive: false }])
    ),
    variables: vi.fn<DebugSectionsClient['variables']>(({ variablesReference }) =>
      ok(
        variablesReference === 100
          ? [variable('obj', '{a: 1}', 200), variable('x', '1')]
          : [variable('a', '1')]
      )
    ),
    evaluate: vi.fn<DebugSectionsClient['evaluate']>(({ expression }) =>
      ok({ result: `value of ${expression}`, variablesReference: 0 })
    ),
    setVariable: vi.fn<DebugSectionsClient['setVariable']>(({ name, value }) =>
      ok(variable(name, value))
    ),
    setExceptionFilters: vi.fn<DebugSectionsClient['setExceptionFilters']>(() => ok(snapshot(50))),
    updateBreakpoint: vi.fn<DebugSectionsClient['updateBreakpoint']>(),
    removeBreakpoint: vi.fn<DebugSectionsClient['removeBreakpoint']>(() => ok(null)),
    listBreakpoints: vi.fn<DebugSectionsClient['listBreakpoints']>(() => ok([]))
  }
}

const fakeStackTrace = () => vi.fn<DebugClient['stackTrace']>(() => ok({ stackFrames: FRAMES }))

let client: ReturnType<typeof fakeClient>
let store: DebugSessionStore
let stackTrace: ReturnType<typeof fakeStackTrace>
let root: Root | null = null
let container: HTMLDivElement

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {})
  }
}

async function mount(
  props: Partial<ComponentProps<typeof DebugPanelSections>> = {}
): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <DebugPanelSections worktreePath={WORKTREE} client={client} store={store} {...props} />
    )
  })
  await flush()
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount())
  root = null
  container.remove()
}

/** The innermost element whose own text is exactly `text`. */
function byText(text: string, scope: ParentNode = container): HTMLElement {
  const match = [...scope.querySelectorAll<HTMLElement>('*')]
    .toReversed()
    .find((element) => element.textContent === text)
  if (!match) {
    throw new Error(`No element with text ${text}`)
  }
  return match
}

function query(selector: string, scope: ParentNode = container): Element {
  const element = scope.querySelector(selector)
  if (!element) {
    throw new Error(`No element ${selector}`)
  }
  return element
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function key(input: Element, name: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })
  await flush()
}

const input = (label: string): HTMLInputElement => {
  const element = container.querySelector(`input[aria-label="${label}"]`)
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`No input ${label}`)
  }
  return element
}

beforeEach(() => {
  window.localStorage.clear()
  client = fakeClient()
  stackTrace = fakeStackTrace()
  store = createDebugSessionStore({
    onState: () => () => {},
    onOutput: () => () => {},
    stackTrace
  })
  store.ingestSnapshot(snapshot(1))
  mocks.store.setState({ openFile: vi.fn(), setPendingEditorReveal: vi.fn() })
})

afterEach(async () => {
  if (root) {
    await unmount()
  }
})

describe('Variables', () => {
  it('fetches children by variablesReference only on expand', async () => {
    await mount()
    expect(client.scopes).toHaveBeenCalledWith({ ...TARGET, frameId: 10 })
    expect(client.variables).not.toHaveBeenCalled()

    await click(byText('Locals'))
    expect(client.variables).toHaveBeenCalledTimes(1)
    expect(client.variables).toHaveBeenLastCalledWith({
      ...TARGET,
      variablesReference: 100
    })

    await click(byText('obj'))
    expect(client.variables).toHaveBeenCalledTimes(2)
    expect(client.variables).toHaveBeenLastCalledWith({
      ...TARGET,
      variablesReference: 200
    })
    expect(byText('a')).toBeTruthy()
  })

  it('pages more than 100 children behind a Show more row', async () => {
    client.scopes.mockImplementation(() =>
      ok([
        {
          name: 'Locals',
          variablesReference: 100,
          namedVariables: 250,
          expensive: false
        }
      ])
    )
    client.variables.mockImplementation(({ start = 0, count = 0 }) =>
      ok(
        Array.from({ length: Math.min(count, 250 - start) }, (_, i) =>
          variable(`v${start + i}`, '0')
        )
      )
    )
    await mount()
    await click(byText('Locals'))
    const values = () => container.querySelectorAll('[data-testid="debug-variable-value"]').length
    expect(client.variables).toHaveBeenLastCalledWith({
      ...TARGET,
      variablesReference: 100,
      start: 0,
      count: 100
    })
    expect(values()).toBe(100)

    await click(byText('Show more'))
    expect(client.variables).toHaveBeenLastCalledWith({
      ...TARGET,
      variablesReference: 100,
      start: 100,
      count: 100
    })
    expect(values()).toBe(200)

    await click(byText('Show more'))
    expect(values()).toBe(250)
    expect(container.textContent).not.toContain('Show more')
  })

  it('pages client-side when the adapter ignores count', async () => {
    client.variables.mockImplementation(() =>
      ok(Array.from({ length: 150 }, (_, i) => variable(`v${i}`, '0')))
    )
    await mount()
    await click(byText('Locals'))
    expect(container.querySelectorAll('[data-testid="debug-variable-value"]')).toHaveLength(100)
    await click(byText('Show more'))
    expect(container.querySelectorAll('[data-testid="debug-variable-value"]')).toHaveLength(150)
    expect(client.variables).toHaveBeenCalledTimes(1)
  })

  it('offers no editor without supportsSetVariable', async () => {
    await mount()
    await click(byText('Locals'))
    await key(byText('1'), 'F2')
    await key(byText('1'), 'Enter')
    expect(container.querySelector('input[aria-label="New value"]')).toBeNull()
  })

  it('edits through setVariable when the adapter supports it', async () => {
    store.ingestSnapshot(snapshot(2, { capabilities: { supportsSetVariable: true } }))
    await mount()
    await click(byText('Locals'))
    expect(byText('1').tagName).toBe('BUTTON')
    await key(byText('1'), 'F2')
    const editor = input('New value')
    await type(editor, '42')
    await key(editor, 'Enter')
    expect(client.setVariable).toHaveBeenCalledWith({
      ...TARGET,
      variablesReference: 100,
      name: 'x',
      value: '42'
    })
    expect(byText('42').title).toBe('42')
  })
})

describe('Watch', () => {
  it('re-evaluates on stop, shows errors as values and survives a remount', async () => {
    await mount()
    const add = input('Add expression')
    await type(add, 'x + 1')
    await key(add, 'Enter')
    expect(client.evaluate).toHaveBeenLastCalledWith({
      ...TARGET,
      expression: 'x + 1',
      frameId: 10,
      context: 'watch'
    })
    expect(container.textContent).toContain('value of x + 1')

    client.evaluate.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        reason: 'request-failed',
        message: "name 'x' is not defined"
      })
    )
    await act(async () => {
      store.ingestSnapshot(snapshot(3, { status: 'running', stopped: null }))
      store.ingestSnapshot(snapshot(4))
    })
    await flush()
    expect(client.evaluate).toHaveBeenCalledTimes(2)
    expect(byText("name 'x' is not defined").className).toContain('text-destructive')

    await unmount()
    await mount()
    expect(container.querySelectorAll('[data-testid="debug-watch-row"]')).toHaveLength(1)
    expect(byText('x + 1')).toBeTruthy()
  })

  it('edits and removes expressions', async () => {
    window.localStorage.setItem(`orca.debug.watch:${WORKTREE}`, JSON.stringify(['a', 'b']))
    await mount()
    expect(byText('a').tagName).toBe('BUTTON')
    await key(byText('a'), 'Enter')
    const editor = input('Edit expression')
    await type(editor, 'c')
    await key(editor, 'Enter')
    expect(JSON.parse(window.localStorage.getItem(`orca.debug.watch:${WORKTREE}`) ?? '')).toEqual([
      'c',
      'b'
    ])
    const [first] = container.querySelectorAll('button[aria-label="Remove expression"]')
    await click(first)
    expect(JSON.parse(window.localStorage.getItem(`orca.debug.watch:${WORKTREE}`) ?? '')).toEqual([
      'b'
    ])
  })
})

describe('Call Stack', () => {
  it('selects a frame, re-targets Variables and the console, and reveals its line', async () => {
    await mount()
    expect(byText('main.py:5')).toBeTruthy()
    await click(byText('helper'))
    expect(client.scopes).toHaveBeenLastCalledWith({ ...TARGET, frameId: 12 })

    const state = mocks.store.getState()
    expect(state.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/real/a/lib.py',
        relativePath: 'lib.py',
        worktreeId: 'repo1::/real/a'
      }),
      expect.anything()
    )
    await vi.waitFor(() =>
      expect(state.setPendingEditorReveal).toHaveBeenLastCalledWith({
        filePath: '/real/a/lib.py',
        line: 7,
        column: 3,
        matchLength: 0
      })
    )

    const evaluate = input('Evaluate expression')
    await type(evaluate, 'y')
    await key(evaluate, 'Enter')
    expect(client.evaluate).toHaveBeenLastCalledWith({
      ...TARGET,
      expression: 'y',
      context: 'repl',
      frameId: 12
    })
  })

  it('dims frames without a source and ignores clicks on them', async () => {
    await mount()
    const native = byText('<native>').closest('button')
    expect(native?.disabled).toBe(true)
    expect(native?.className).toContain('text-muted-foreground')
    await click(byText('<native>'))
    expect(store.getState(WORKTREE).selectedFrameId).toBe(10)
  })
})

describe('Breakpoints', () => {
  const breakpoint: DebugBreakpointWire = {
    id: 'bp1',
    path: '/real/a/main.py',
    line: 5,
    enabled: true,
    answer: { state: 'failed', message: 'No code at line' }
  }

  it('toggles, removes and reveals breakpoints and sets exception filters', async () => {
    client.listBreakpoints.mockImplementation(() => ok([breakpoint]))
    client.updateBreakpoint.mockImplementation(() => ok({ ...breakpoint, enabled: false }))
    store.ingestSnapshot(
      snapshot(2, {
        exceptionFilters: {
          available: [
            { filter: 'raised', label: 'Raised Exceptions', default: false },
            { filter: 'uncaught', label: 'Uncaught Exceptions', default: true }
          ],
          enabled: ['uncaught']
        }
      })
    )
    await mount()
    expect(byText('main.py')).toBeTruthy()
    expect(byText('Failed').title).toBe('No code at line')

    await click(query('button[aria-label="Enable breakpoint"]'))
    expect(client.updateBreakpoint).toHaveBeenCalledWith({
      ...TARGET,
      id: 'bp1',
      fields: { enabled: false }
    })

    await click(query('button', byText('Raised Exceptions').closest('label') ?? container))
    expect(client.setExceptionFilters).toHaveBeenCalledWith({
      ...TARGET,
      filters: ['uncaught', 'raised']
    })

    await click(byText('Line 5'))
    await vi.waitFor(() =>
      expect(mocks.store.getState().setPendingEditorReveal).toHaveBeenLastCalledWith(
        expect.objectContaining({ filePath: '/real/a/main.py', line: 5 })
      )
    )

    await click(query('button[aria-label="Remove breakpoint"]'))
    expect(client.removeBreakpoint).toHaveBeenCalledWith({
      ...TARGET,
      id: 'bp1'
    })
  })
})

describe('Debug Console', () => {
  it('shows stripped output, colours stderr, evaluates with repl and keeps history', async () => {
    store.ingestOutput({
      worktreePath: WORKTREE,
      seq: 1,
      ts: 1,
      category: 'stdout',
      text: '\u001b[32mready\u001b[0m\n'
    })
    store.ingestOutput({
      worktreePath: WORKTREE,
      seq: 2,
      ts: 2,
      category: 'stderr',
      text: 'warn\n'
    })
    await mount()
    expect(byText('ready').dataset.category).toBe('stdout')
    expect(byText('warn').className).toContain('text-destructive')

    const field = input('Evaluate expression')
    await type(field, 'a')
    await key(field, 'Enter')
    expect(client.evaluate).toHaveBeenLastCalledWith({
      ...TARGET,
      expression: 'a',
      context: 'repl',
      frameId: 10
    })
    expect(byText('value of a')).toBeTruthy()

    client.evaluate.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        reason: 'request-failed',
        message: 'SyntaxError'
      })
    )
    await type(field, 'b(')
    await key(field, 'Enter')
    expect(byText('SyntaxError').dataset.category).toBe('error')

    await key(field, 'ArrowUp')
    expect(field.value).toBe('b(')
    await key(field, 'ArrowUp')
    expect(field.value).toBe('a')
    await key(field, 'ArrowDown')
    await key(field, 'ArrowDown')
    expect(field.value).toBe('')
  })
})

describe('core path vs renderer path', () => {
  it('reads the store by core path and still resolves the Orca worktree to reveal', async () => {
    const CORE = '/private/real/a'
    store.ingestSnapshot(snapshot(1, {}, CORE))
    await mount({ worktreePath: CORE, rendererPath: WORKTREE })
    const core = { repoId: 'repo1', worktreePath: CORE }
    expect(client.scopes).toHaveBeenCalledWith({ ...core, frameId: 10 })
    expect(byText('main.py:5')).toBeTruthy()

    await click(byText('helper'))
    expect(mocks.store.getState().openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/real/a/lib.py',
        relativePath: 'lib.py',
        worktreeId: 'repo1::/real/a'
      }),
      expect.anything()
    )
  })
})

describe('re-stop on the same thread', () => {
  it('reloads frames, scopes and watches without a running snapshot between', async () => {
    window.localStorage.setItem(`orca.debug.watch:${WORKTREE}`, JSON.stringify(['w']))
    await mount()
    const before = {
      stack: stackTrace.mock.calls.length,
      scopes: client.scopes.mock.calls.length,
      evaluate: client.evaluate.mock.calls.length
    }
    await act(async () => {
      store.ingestSnapshot(snapshot(2))
    })
    await flush()
    await act(async () => {
      store.ingestSnapshot(snapshot(3))
    })
    await flush()
    expect(stackTrace.mock.calls.length).toBe(before.stack + 2)
    expect(client.scopes.mock.calls.length).toBeGreaterThanOrEqual(before.scopes + 2)
    expect(client.evaluate.mock.calls.length).toBeGreaterThanOrEqual(before.evaluate + 2)
  })
})

describe('keyboard access', () => {
  it('uses lists and real buttons, not tree roles, and expands through a button', async () => {
    await mount()
    await click(byText('Locals'))
    expect(container.querySelector('[role="tree"], [role="treeitem"]')).toBeNull()
    const toggle = byText('obj').closest('button')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.tabIndex).toBe(0)
    await click(toggle ?? container)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(byText('a')).toBeTruthy()
  })

  it('shows the full variable name in a title', async () => {
    await mount()
    await click(byText('Locals'))
    expect(byText('obj').closest('button')?.title).toBe('obj')
  })
})

describe('Show more paging', () => {
  it('issues one request for a double click while a page is pending', async () => {
    client.scopes.mockImplementation(() =>
      ok([
        {
          name: 'Locals',
          variablesReference: 100,
          namedVariables: 250,
          expensive: false
        }
      ])
    )
    let release: (() => void) | undefined
    client.variables.mockImplementation(({ start = 0, count = 0 }) => {
      const page = ok(
        Array.from({ length: Math.min(count, 250 - start) }, (_, i) =>
          variable(`v${start + i}`, '0')
        )
      )
      return start === 0
        ? page
        : new Promise((resolve) => {
            release = () => void page.then(resolve)
          })
    })
    await mount()
    await click(byText('Locals'))
    const more = byText('Show more').closest('button')
    if (!more) {
      throw new Error('No Show more button')
    }
    await click(more)
    await click(more)
    expect(client.variables).toHaveBeenCalledTimes(2)
    expect(more.disabled).toBe(true)
    await act(async () => release?.())
    await flush()
    expect(container.querySelectorAll('[data-testid="debug-variable-value"]')).toHaveLength(200)
  })
})

describe('rejections and loading states', () => {
  it('shows an error when scopes rejects', async () => {
    client.scopes.mockImplementation(() => Promise.reject(new Error('scopes boom')))
    await mount()
    expect(query('[role="alert"]').textContent).toBe('scopes boom')
  })

  it('shows a loading state while scopes is pending', async () => {
    client.scopes.mockImplementation(() => new Promise(() => {}))
    await mount()
    expect(container.textContent).toContain('Loading…')
  })

  it('shows a rejected watch evaluate as the value, and a pending marker meanwhile', async () => {
    window.localStorage.setItem(`orca.debug.watch:${WORKTREE}`, JSON.stringify(['w']))
    client.evaluate.mockImplementation(() => new Promise(() => {}))
    await mount()
    expect(byText('Evaluating').className).toContain('sr-only')
    await unmount()
    client.evaluate.mockImplementation(() => Promise.reject(new Error('eval boom')))
    await mount()
    expect(byText('eval boom').className).toContain('text-destructive')
  })

  it('shows a rejected console evaluate as an error line', async () => {
    client.evaluate.mockImplementation(() => Promise.reject(new Error('repl boom')))
    await mount()
    const field = input('Evaluate expression')
    await type(field, 'z')
    await key(field, 'Enter')
    expect(byText('repl boom').dataset.category).toBe('error')
  })

  it('shows an error when listing breakpoints rejects', async () => {
    client.listBreakpoints.mockImplementation(() => Promise.reject(new Error('list boom')))
    await mount()
    expect(byText('list boom').getAttribute('role')).toBe('alert')
  })

  it('shows the empty breakpoints message even when exception filters exist', async () => {
    store.ingestSnapshot(
      snapshot(2, {
        exceptionFilters: {
          available: [{ filter: 'raised', label: 'Raised Exceptions', default: false }],
          enabled: []
        }
      })
    )
    await mount()
    expect(byText('Raised Exceptions')).toBeTruthy()
    expect(byText('No breakpoints')).toBeTruthy()
  })

  it('shows a call stack loading state until the frames arrive', async () => {
    stackTrace.mockImplementation(() => new Promise(() => {}))
    await mount()
    const stack = byText('Paused on breakpoint').closest('li')
    expect(stack?.textContent).toContain('Loading…')
  })
})

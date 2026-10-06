import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-session-contracts'
import {
  ENVIRONMENT_ID,
  makeSnapshot,
  pendingSurface
} from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  isAdoptionResult,
  isRpcResponse,
  readClientSessionSnapshotAfterAdoption
} from './web-session-terminal-orphan-recovery-adoption'
import { clearWebSessionTerminalOrphanRecoveryForTests } from './web-session-terminal-orphan-recovery'
import { isTerminalRecoverySnapshot } from './web-session-terminal-recovery-snapshot-validation'

const WORKTREE = 'folder:recovery-validation'
const pending = pendingSurface('host-tab', 'leaf-1', 'pty-1')
delete pending.ptyId
const ready = { ...pending, status: 'ready' as const, terminal: 'term-1' }
const file = {
  type: 'file' as const,
  id: 'file-1',
  title: '',
  filePath: 'C:\\workspace\\file.ts',
  relativePath: 'file.ts',
  language: 'typescript',
  isDirty: false,
  isActive: false
}
const markdown = {
  ...file,
  type: 'markdown' as const,
  language: 'markdown' as const,
  mode: 'markdown-preview' as const,
  sourceFileId: 'source-1',
  sourceFilePath: '/workspace/notes.md',
  sourceRelativePath: 'notes.md',
  documentVersion: 'v1'
}
const browser = {
  type: 'browser' as const,
  id: 'browser-1',
  title: 'Docs',
  browserWorkspaceId: 'browser-workspace',
  browserPageId: 'page-1',
  url: 'https://example.com',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: false
}
const agent = {
  type: 'agent-session' as const,
  id: 'agent-1',
  title: 'Agent',
  sessionId: 'session-1',
  agent: 'claude' as const,
  isActive: false
}
const rows = [
  { name: 'pending terminal', row: pending },
  { name: 'ready terminal', row: ready },
  { name: 'markdown', row: markdown },
  { name: 'file', row: file },
  { name: 'browser', row: browser },
  { name: 'agent-session', row: agent }
] satisfies { name: string; row: RuntimeMobileSessionClientTab }[]

function snapshot(tabs: unknown[] = []) {
  return { ...makeSnapshot(WORKTREE, 'client-epoch', []), tabs }
}

async function expectBoundaryVerdict(value: unknown, valid: boolean): Promise<void> {
  expect(isTerminalRecoverySnapshot(value)).toBe(valid)
  expect(isAdoptionResult({ adopted: true, topologyRevision: 1, snapshot: value })).toBe(valid)
  const result = await readClientSessionSnapshotAfterAdoption({
    environmentId: ENVIRONMENT_ID,
    worktreeId: WORKTREE,
    call: vi.fn(async () => ({
      id: 'validation',
      ok: true as const,
      result: value,
      _meta: { runtimeId: 'host-runtime' }
    })),
    isCurrent: () => true
  })
  expect(result).toBe(valid ? value : null)
}

const fullSnapshot: RuntimeMobileSessionTabsResult = {
  ...snapshot(),
  navigationIntent: 'follow',
  activeGroupId: 'group-1',
  activeTabId: ready.id,
  activeTabType: 'terminal',
  clientHostedPagesUnreconciled: true,
  tabGroups: [{ id: 'group-1', activeTabId: 'host-tab', tabOrder: ['host-tab'], recentTabIds: [] }],
  tabGroupLayout: {
    type: 'split',
    direction: 'vertical',
    ratio: 0.5,
    first: { type: 'leaf', groupId: 'group-1' },
    second: { type: 'leaf', groupId: 'group-2' }
  },
  retiredTerminalSurfaces: [
    {
      parentTabId: 'old-tab',
      leafId: 'old-leaf',
      ptyId: 'old-pty',
      terminal: 'old-term',
      incarnationId: 'old-incarnation'
    }
  ],
  tabs: [
    {
      ...ready,
      quickCommandLabel: null,
      ptyId: null,
      incarnationId: null,
      agentStatus: {
        state: 'working',
        prompt: '',
        updatedAt: 10,
        stateStartedAt: 1,
        paneKey: 'host-tab:leaf-1',
        stateHistory: []
      },
      launchAgent: 'claude',
      parentLayout: {
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.6,
          first: { type: 'leaf', leafId: 'leaf-1' },
          second: { type: 'leaf', leafId: 'leaf-2' }
        },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': 'pty-1' },
        titlesByLeafId: { 'leaf-1': 'Shell' }
      },
      color: null,
      isPinned: true,
      viewMode: 'chat'
    },
    {
      ...browser,
      placement: {
        kind: 'client',
        browserHostClientId: 'client',
        browserHostGeneration: 1,
        pageHostGeneration: 2
      },
      loadError: null
    },
    { ...file, mode: 'diff', diffSource: 'unstaged' },
    { ...markdown, mode: 'edit' },
    { ...agent, agent: 'codex' }
  ]
}

function withField(value: unknown, path: string, replacement: unknown): unknown {
  const copy = structuredClone(value)
  const keys = path.split('.')
  let parent = copy as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    parent = parent[key] as Record<string, unknown>
  }
  parent[keys.at(-1)!] = replacement
  return copy
}

function readField(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], value)
}

describe('terminal recovery session-tabs snapshot validation', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it.each(rows)('accepts a complete $name row without optional fields', async ({ row }) => {
    await expectBoundaryVerdict(snapshot([row]), true)
  })

  it('accepts an empty inventory only with a complete envelope', async () => {
    await expectBoundaryVerdict(snapshot(), true)
  })

  it.each(Object.keys(snapshot()))(
    'rejects a missing or mistyped required %s field',
    async (key) => {
      const missing: Record<string, unknown> = snapshot()
      delete missing[key]
      await expectBoundaryVerdict(missing, false)
      await expectBoundaryVerdict({ ...snapshot(), [key]: true }, false)
    }
  )

  // Coordinates and handles are what recovery merges on; nothing else in a row is required.
  it.each(['id', 'title', 'isActive', 'type', 'parentTabId', 'leafId', 'status', 'terminal'])(
    'rejects a terminal row missing or mistyping %s',
    async (key) => {
      const missing: Record<string, unknown> = { ...ready }
      delete missing[key]
      await expectBoundaryVerdict(snapshot([missing]), false)
      await expectBoundaryVerdict(snapshot([{ ...ready, [key]: {} }]), false)
    }
  )

  it.each(['id', 'title', 'isActive', 'type'])(
    'rejects a non-terminal row missing or mistyping %s',
    async (key) => {
      const missing: Record<string, unknown> = { ...browser }
      delete missing[key]
      await expectBoundaryVerdict(snapshot([missing]), false)
      await expectBoundaryVerdict(snapshot([{ ...browser, [key]: {} }]), false)
    }
  )

  it.each([null, undefined, 1, 'snapshot', [], {}, Object.assign([], snapshot())])(
    'rejects non-snapshot records: %j',
    async (value) => expectBoundaryVerdict(value, false)
  )

  it.each([null, undefined, 1, 'tab', [], {}, Object.assign([], ready)])(
    'rejects malformed rows without salvaging other rows: %j',
    async (row) => {
      const value = snapshot([ready, row, browser])
      await expectBoundaryVerdict(value, false)
      expect(value.tabs).toEqual([ready, row, browser])
    }
  )

  it.each([
    { ...pending, terminal: 'term-1' },
    { ...pending, status: 'unknown' },
    { ...ready, terminal: null },
    { ...ready, terminal: '' },
    { ...ready, terminal: '  ' },
    { ...ready, status: 'exited' }
  ])('rejects terminal rows whose handle and status disagree: %j', async (row) => {
    await expectBoundaryVerdict(snapshot([row]), false)
  })

  it.each(['', '  ', 0, null])('rejects invalid identity %j', (value) => {
    for (const path of [
      'worktree',
      'publicationEpoch',
      'tabs.0.id',
      'tabs.0.parentTabId',
      'tabs.0.leafId'
    ]) {
      expect(isTerminalRecoverySnapshot(withField(snapshot([ready]), path, value)), path).toBe(
        false
      )
    }
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects invalid snapshot version %j',
    async (snapshotVersion) => {
      await expectBoundaryVerdict({ ...snapshot(), snapshotVersion }, false)
    }
  )

  it('accepts current optional metadata without modifying the payload', async () => {
    const original = structuredClone(fullSnapshot)
    await expectBoundaryVerdict(fullSnapshot, true)
    expect(fullSnapshot).toEqual(original)
  })

  it.each([
    'tabGroups',
    'tabGroups.0',
    'tabGroupLayout',
    'tabGroupLayout.first',
    'retiredTerminalSurfaces',
    'retiredTerminalSurfaces.0',
    'tabs',
    'tabs.0',
    'tabs.0.parentLayout',
    'tabs.0.parentLayout.root',
    'tabs.0.parentLayout.ptyIdsByLeafId'
  ])('rejects the wrong container kind for consumed structure at %s', (path) => {
    const wrongKind = Array.isArray(readField(fullSnapshot, path)) ? {} : []
    expect(isTerminalRecoverySnapshot(withField(fullSnapshot, path, wrongKind))).toBe(false)
  })

  it.each([
    ['tabGroups', [{}]],
    ['tabGroups.0.id', ''],
    ['tabGroups.0.activeTabId', undefined],
    ['tabGroups.0.tabOrder', [null]],
    ['tabGroups.0.recentTabIds', [false]],
    ['tabGroupLayout.type', 'unknown'],
    ['tabGroupLayout.first', null],
    ['tabGroupLayout.second', { type: 'leaf' }],
    ['retiredTerminalSurfaces', [{}]],
    ['retiredTerminalSurfaces.0.ptyId', undefined],
    ['retiredTerminalSurfaces.0.terminal', ''],
    ['retiredTerminalSurfaces.0.leafId', ' '],
    ['retiredTerminalSurfaces.0.incarnationId', null],
    ['tabs.0.parentLayout', {}],
    ['tabs.0.parentLayout.root', { type: 'split' }],
    ['tabs.0.parentLayout.root.second', {}],
    ['tabs.0.parentLayout.root.first.leafId', ''],
    ['tabs.0.parentLayout.activeLeafId', undefined],
    ['tabs.0.parentLayout.expandedLeafId', undefined],
    ['tabs.0.parentLayout.ptyIdsByLeafId', { leaf: null }],
    ['tabs.0.ptyId', 1],
    ['tabs.0.incarnationId', false],
    ['activeTabType', 1],
    ['activeTabId', undefined],
    ['activeGroupId', undefined]
  ] as const)('rejects incomplete/invalid consumed structure at %s (%j)', async (path, value) => {
    await expectBoundaryVerdict(withField(fullSnapshot, path, value), false)
  })

  it('allows nullable and absent mixed-version metadata without inserting defaults', async () => {
    const value = snapshot([
      {
        ...pending,
        ptyId: null,
        incarnationId: null,
        agentStatus: null,
        parentLayout: { root: null, activeLeafId: null, expandedLeafId: null }
      },
      { ...browser, browserPageId: null, placement: { kind: 'server' }, loadError: null },
      { ...file, mode: 'edit', diffSource: 'staged' }
    ])
    await expectBoundaryVerdict({ ...value, tabGroupLayout: null, tabGroups: undefined }, true)
    const legacy = snapshot([ready, file, browser])
    await expectBoundaryVerdict(legacy, true)
    expect(legacy).not.toHaveProperty('tabGroups')
    expect(legacy.tabs[0]).not.toHaveProperty('ptyId')
    expect(legacy.tabs[2]).not.toHaveProperty('placement')
  })

  // Wire-compat Rule 3: a newer host may publish labels this client has never seen. Rejecting the
  // whole snapshot would stall recovery forever; recovery reads none of these, so they pass through.
  it.each([
    ['tabs.4.agent', 'gemini'],
    ['tabs.0.agentStatus.state', 'future-state'],
    ['tabs.0.agentStatus', { state: 'working' }],
    ['tabs.0.viewMode', 'future-view'],
    ['tabs.0.launchAgent', 'future-agent'],
    ['tabs.0.terminalTheme', { mode: 'sepia' }],
    ['tabs.0.parentLayout.root.direction', 'diagonal'],
    ['tabs.0.parentLayout.root.ratio', 2],
    ['tabs.0.parentLayout.titlesByLeafId', { 'leaf-1': 1 }],
    ['tabs.1.placement', { kind: 'future-host' }],
    ['tabs.1.loadError', { code: 'string' }],
    ['tabs.2.mode', 'future-mode'],
    ['tabs.2.diffSource', 'future-source'],
    ['tabs.3.language', 'future-language'],
    ['tabGroupLayout.direction', 'diagonal'],
    ['tabGroupLayout.ratio', 2],
    ['navigationIntent', 'future-intent'],
    ['activeTabType', 'future-tab'],
    ['clientHostedPagesUnreconciled', false]
  ] as const)('accepts a newer host publishing %s = %j', async (path, value) => {
    const newer = withField(fullSnapshot, path, value)
    await expectBoundaryVerdict(newer, true)
    expect(newer).toEqual(withField(fullSnapshot, path, value))
  })

  it('accepts a newer host publishing a tab kind this client cannot render', async () => {
    const notebook = { type: 'notebook', id: 'nb-1', title: 'Notebook', isActive: false, cells: [] }
    const value = snapshot([ready, notebook, browser])
    await expectBoundaryVerdict(value, true)
    expect(value.tabs[1]).toBe(notebook)
  })

  it('preserves unknown additive fields at every snapshot depth', async () => {
    const additive = { future: { nested: [null, false, {}] } }
    const extend = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(extend)
      }
      if (value === null || typeof value !== 'object') {
        return value
      }
      // Leaf maps are string records, not extensible metadata objects.
      const entries = Object.entries(value).map(([key, child]) => [
        key,
        key.endsWith('ByLeafId') ? child : extend(child)
      ])
      return { ...Object.fromEntries(entries), ...additive }
    }
    const value = extend(fullSnapshot)
    const original = structuredClone(value)
    await expectBoundaryVerdict(value, true)
    expect(value).toEqual(original)
  })

  it('fails closed when reading the payload throws instead of propagating', () => {
    const hostile = snapshot([ready]) as Record<string, unknown>
    Object.defineProperty(hostile, 'tabGroups', {
      enumerable: true,
      get() {
        throw new Error('poisoned accessor')
      }
    })
    expect(isTerminalRecoverySnapshot(hostile)).toBe(false)
  })

  it('rejects arrays used as adoption or RPC envelopes', () => {
    expect(
      isAdoptionResult(
        Object.assign([], { adopted: true, topologyRevision: 1, snapshot: snapshot() })
      )
    ).toBe(false)
    expect(isRpcResponse(Object.assign([], { ok: true, result: snapshot() }))).toBe(false)
  })
})

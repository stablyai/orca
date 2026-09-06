import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-session-contracts'
import { TERMINAL_COLOR_KEYS } from '../../../shared/terminal-custom-themes'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
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

const status: AgentStatusEntry = {
  state: 'working',
  prompt: '',
  updatedAt: 10,
  stateStartedAt: 1,
  paneKey: 'host-tab:leaf-1',
  stateHistory: [{ state: 'done', prompt: '', startedAt: 0, interrupted: false }],
  workingMode: 'monitoring',
  evidenceObservedAt: 9,
  agentType: 'custom-agent',
  model: 'model',
  terminalHandle: 'term-1',
  worktreeId: WORKTREE,
  connectionId: null,
  tabId: 'host-tab',
  terminalTitle: 'Agent',
  toolName: 'Read',
  toolInput: 'file.ts',
  interactivePrompt: '{}',
  lastAssistantMessage: 'Working',
  lastAssistantMessageIsToolOutput: false,
  lastCompletedAssistantMessage: 'Done',
  interrupted: false,
  sessionBoundary: false,
  terminalResumeEligible: false,
  promptInteractionKey: 'turn-1',
  restoredUnconfirmed: false,
  mirroredEvidenceReceivedAt: 10,
  acceptedStatusSeq: 0,
  orchestration: {
    taskId: 'task-1',
    dispatchId: 'dispatch-1',
    dispatchStatus: 'dispatched',
    taskTitle: 'Task',
    displayName: 'Worker',
    parentTerminalHandle: 'term-parent',
    parentPaneKey: 'parent:leaf',
    coordinatorHandle: 'term-parent',
    orchestrationRunId: 'run-1'
  },
  subagents: [
    {
      id: 'child',
      agentType: 'custom',
      model: 'model',
      description: '',
      state: 'idle',
      startedAt: 2
    }
  ],
  providerSession: {
    key: 'conversation_id',
    id: 'conversation-1',
    transcriptPath: '/remote/transcript'
  },
  observation: {
    origin: 'hook',
    authorityId: 'host',
    incarnation: 0,
    revision: 1,
    observedAt: 9,
    boundary: true,
    kind: 'transition'
  }
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
      terminalTheme: {
        mode: 'dark',
        theme: Object.fromEntries(TERMINAL_COLOR_KEYS.map((key) => [key, '#ffffff']))
      },
      agentStatus: status,
      turnCompletedAt: 10,
      launchAgent: 'claude',
      startupCwd: '/remote/folder',
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
        buffersByLeafId: { 'leaf-1': 'buffer' },
        scrollbackRefsByLeafId: { 'leaf-1': 'ref' },
        titlesByLeafId: { 'leaf-1': 'Shell' }
      },
      color: null,
      isPinned: true,
      viewMode: 'chat',
      launchDraft: '',
      launchDraftCreatedAt: 0
    },
    {
      ...browser,
      browserProfileId: 'profile',
      executionHostKey: 'ssh:remote',
      placement: {
        kind: 'client',
        browserHostClientId: 'client',
        browserHostGeneration: 1,
        pageHostGeneration: 2
      },
      loadError: { code: -1, description: 'Failed', validatedUrl: 'https://example.com' },
      certificateFailure: {
        challengeId: 'challenge',
        browserPageId: 'page-1',
        errorCode: null,
        error: 'certificate error',
        origin: 'https://example.com',
        displayHost: 'example.com',
        canProceed: false,
        observedAt: 10
      },
      color: 'blue',
      isPinned: false
    },
    { ...file, mode: 'diff', diffSource: 'unstaged', color: null, isPinned: false },
    { ...markdown, mode: 'edit', color: null, isPinned: true },
    { ...agent, agent: 'codex', color: null, isPinned: false }
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

// Every populated metadata field must reject a wrong type, including the record/array boundaries.
function malformedFieldCases(value: unknown, prefix = ''): { path: string; invalid: unknown }[] {
  if (value === null || typeof value !== 'object') {
    return []
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return [{ path, invalid: Array.isArray(entry) ? {} : [] }, ...malformedFieldCases(entry, path)]
  })
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

  it.each(rows)('rejects every missing or mistyped required $name field', async ({ row }) => {
    for (const key of Object.keys(row)) {
      const missing: Record<string, unknown> = { ...row }
      delete missing[key]
      await expectBoundaryVerdict(snapshot([missing]), false)
      await expectBoundaryVerdict(snapshot([{ ...row, [key]: {} }]), false)
    }
  })

  it.each([null, undefined, 1, 'snapshot', [], {}, Object.assign([], snapshot())])(
    'rejects non-snapshot records: %j',
    async (value) => expectBoundaryVerdict(value, false)
  )

  it.each([
    null,
    undefined,
    1,
    'tab',
    [],
    {},
    Object.assign([], ready),
    { ...ready, type: 'future-tab' }
  ])('rejects malformed rows without salvaging other rows: %j', async (row) => {
    const value = snapshot([ready, row, browser])
    await expectBoundaryVerdict(value, false)
    expect(value.tabs).toEqual([ready, row, browser])
  })

  it.each([
    { ...pending, terminal: 'term-1' },
    { ...pending, status: 'unknown' },
    { ...ready, terminal: null },
    { ...ready, terminal: '' },
    { ...ready, terminal: '  ' },
    { ...markdown, language: 'typescript' },
    { ...markdown, mode: 'diff' },
    { ...file, mode: 'markdown-preview' },
    { ...file, diffSource: 'unknown' },
    { ...agent, agent: 'unknown' }
  ])('rejects invalid row discriminants and handles: %j', async (row) => {
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

  it.each(malformedFieldCases(fullSnapshot))(
    'rejects malformed consumed metadata at $path',
    ({ path, invalid }) => {
      expect(isTerminalRecoverySnapshot(withField(fullSnapshot, path, invalid))).toBe(false)
    }
  )

  it.each([
    'tabGroups.0',
    'tabGroupLayout',
    'tabGroupLayout.first',
    'retiredTerminalSurfaces.0',
    'tabs.0.parentLayout',
    'tabs.0.parentLayout.root',
    'tabs.0.parentLayout.ptyIdsByLeafId',
    'tabs.0.parentLayout.buffersByLeafId',
    'tabs.0.parentLayout.scrollbackRefsByLeafId',
    'tabs.0.parentLayout.titlesByLeafId',
    'tabs.0.terminalTheme',
    'tabs.0.terminalTheme.theme',
    'tabs.0.agentStatus',
    'tabs.0.agentStatus.stateHistory.0',
    'tabs.0.agentStatus.orchestration',
    'tabs.0.agentStatus.subagents.0',
    'tabs.0.agentStatus.providerSession',
    'tabs.0.agentStatus.observation',
    'tabs.1.placement',
    'tabs.1.loadError',
    'tabs.1.certificateFailure'
  ])('rejects arrays masquerading as nested records at %s', (path) => {
    expect(isTerminalRecoverySnapshot(withField(fullSnapshot, path, []))).toBe(false)
  })

  it.each([
    ['tabGroups', [{}]],
    ['tabGroups.0.activeTabId', undefined],
    ['tabGroups.0.tabOrder', [null]],
    ['tabGroups.0.recentTabIds', [false]],
    ['tabGroupLayout.type', 'unknown'],
    ['tabGroupLayout.direction', 'diagonal'],
    ['tabGroupLayout.first', null],
    ['tabGroupLayout.second', { type: 'leaf' }],
    ['tabGroupLayout.ratio', 2],
    ['retiredTerminalSurfaces', [{}]],
    ['retiredTerminalSurfaces.0.ptyId', undefined],
    ['retiredTerminalSurfaces.0.terminal', ''],
    ['retiredTerminalSurfaces.0.incarnationId', null],
    ['tabs.0.parentLayout.root.second', {}],
    ['tabs.0.parentLayout.root.direction', 'diagonal'],
    ['tabs.0.parentLayout.root.ratio', Number.NaN],
    ['tabs.0.parentLayout.activeLeafId', undefined],
    ['tabs.0.parentLayout.expandedLeafId', undefined],
    ['tabs.0.parentLayout.ptyIdsByLeafId', { leaf: null }],
    ['tabs.0.agentStatus', {}],
    ['tabs.0.agentStatus.state', 'unknown'],
    ['tabs.0.agentStatus.stateHistory', [{}]],
    ['tabs.0.agentStatus.subagents', [{}]],
    ['tabs.0.agentStatus.orchestration', {}],
    ['tabs.0.agentStatus.providerSession', {}],
    ['tabs.0.agentStatus.observation', {}],
    ['tabs.0.terminalTheme', {}],
    ['tabs.0.terminalTheme.mode', 'unknown'],
    ['tabs.0.launchAgent', 'unknown'],
    ['tabs.0.viewMode', 'unknown'],
    ['tabs.1.placement', { kind: 'client' }],
    ['tabs.1.placement.kind', 'unknown'],
    ['tabs.1.loadError', {}],
    ['tabs.1.certificateFailure', {}],
    ['navigationIntent', 'unknown'],
    ['activeTabType', 'editor'],
    ['clientHostedPagesUnreconciled', false]
  ] as const)('rejects incomplete/invalid structural metadata at %s (%j)', async (path, value) => {
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
      {
        ...browser,
        browserPageId: null,
        placement: { kind: 'server' },
        loadError: null,
        certificateFailure: null
      },
      { ...file, mode: 'edit', diffSource: 'staged' }
    ])
    await expectBoundaryVerdict({ ...value, tabGroupLayout: null, tabGroups: undefined }, true)
    const legacy = snapshot([ready, file, browser])
    await expectBoundaryVerdict(legacy, true)
    expect(legacy).not.toHaveProperty('tabGroups')
    expect(legacy.tabs[0]).not.toHaveProperty('ptyId')
    expect(legacy.tabs[2]).not.toHaveProperty('placement')
  })

  it.each(Object.keys(TUI_AGENT_CONFIG))(
    'accepts the existing launch-agent domain: %s',
    async (launchAgent) => {
      await expectBoundaryVerdict(snapshot([{ ...ready, launchAgent }]), true)
    }
  )

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

  it('fails closed on cyclic layouts instead of throwing', () => {
    const layout: Record<string, unknown> = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-1' }
    }
    layout.second = layout
    expect(isTerminalRecoverySnapshot({ ...snapshot(), tabGroupLayout: layout })).toBe(false)
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

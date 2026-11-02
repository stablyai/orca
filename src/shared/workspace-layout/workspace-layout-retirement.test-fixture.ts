import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import type { TabGroupLayoutNode } from '../tab-types'
import type { CarriedSessionFields } from './workspace-layout-beside'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type { LayoutTerminalTab, WorkspaceLayoutModel } from './workspace-layout-model'
import { addWorkspace, emptySession, GIT_KEY, leaf } from './workspace-layout-session.test-fixture'

export const paneLeaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
export const paneSplit = (
  first: TerminalPaneLayoutNode,
  second: TerminalPaneLayoutNode
): Extract<TerminalPaneLayoutNode, { type: 'split' }> => ({
  type: 'split',
  direction: 'horizontal',
  first,
  second
})
export const groupLeaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
export const groupSplit = (
  first: TabGroupLayoutNode,
  second: TabGroupLayoutNode
): Extract<TabGroupLayoutNode, { type: 'split' }> => ({
  type: 'split',
  direction: 'horizontal',
  first,
  second,
  ratio: 0.4
})

export const tombstone = (parentTabId: string, leafId: string, incarnationId = '') => ({
  parentTabId,
  leafId,
  incarnationId,
  ptyId: `pty-${leafId}`,
  worktreeId: GIT_KEY,
  retiredAt: 1
})

export const terminal = (
  id: string,
  entityId: string,
  root: TerminalPaneLayoutNode
): LayoutTerminalTab => ({
  kind: 'terminal',
  id,
  entityId,
  createdAt: 1,
  customTitle: null,
  color: null,
  terminal: { defaultTitle: entityId },
  panes: { root }
})

export function phaseInput() {
  const model: WorkspaceLayoutModel = {
    hostId: 'local',
    records: {},
    legacy: { terminalRowOwners: { [GIT_KEY]: true } },
    workspaces: {
      [GIT_KEY]: {
        worktreeId: GIT_KEY,
        tabs: [
          terminal('target', 'X', paneSplit(paneLeaf('a'), paneLeaf('b'))),
          terminal('keep', 'Y', paneLeaf('z'))
        ],
        groups: [
          { id: 'g1', tabOrder: ['target'] },
          { id: 'g2', tabOrder: ['keep'] }
        ],
        groupLayout: groupSplit(groupLeaf('g1'), groupSplit(groupLeaf('g1'), groupLeaf('g2'))),
        leaves: { a: { ptyId: 'pty-a' }, b: { ptyId: 'pty-b' }, z: { ptyId: 'pty-z' } }
      }
    }
  }
  const carried: CarriedSessionFields = {
    unownedTerminalLayouts: {},
    unplacedSleepingRecords: {},
    unplacedIncarnations: { 'X:gone': 'carry', 'X:a': 'success-stays' },
    unplacedClosedTabs: {}
  }
  const session = emptySession()
  session.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
    [tombstone('X', 'gone'), tombstone('X', 'a'), tombstone('X', 'b'), tombstone('X', 'b')].map(
      (value, index) => [String(index), value]
    )
  )
  return { model, carried, session }
}

export function cohortInput(): WorkspaceSessionState {
  const c = leaf(1),
    d = leaf(2),
    a = leaf(3),
    b = leaf(4),
    e = leaf(5)
  const saved = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'g2',
      tabs: [
        {
          id: 'unique',
          entityId: 'row-c',
          leaves: [
            [c, 'pc'],
            [d, 'pd']
          ]
        }
      ]
    },
    {
      id: 'g1',
      tabs: [
        {
          id: 'cohort',
          entityId: 'row-a',
          leaves: [
            [a, 'pa'],
            [b, 'pb']
          ]
        }
      ]
    }
  ])
  const extra = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'g1',
      tabs: [
        {
          id: 'cohort',
          leaves: [
            [c, 'extra-c'],
            [e, 'extra-e']
          ]
        }
      ]
    }
  ])
  saved.tabsByWorktree[GIT_KEY].push(extra.tabsByWorktree[GIT_KEY][0])
  saved.terminalLayoutsByTabId.cohort = extra.terminalLayoutsByTabId.cohort
  saved.tabGroupLayouts![GIT_KEY] = groupSplit(
    groupLeaf('g1'),
    groupSplit(groupLeaf('g1'), groupLeaf('g2'))
  )
  saved.terminalPtyIncarnationsByPaneKey = {
    [`row-a:${a}`]: 'carried-a',
    [`row-a:${b}`]: 'carried-b'
  }
  saved.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
    [
      tombstone('row-a', a),
      tombstone('cohort', c),
      tombstone('row-a', b),
      tombstone('row-a', b),
      { ...tombstone('row-c', d, 'different'), ptyId: 'wrong' }
    ].map((value, index) => [String(index), value])
  )
  return saved
}

type RetirementObservedObject = Record<string | symbol, unknown>

type RetirementObservedProperty = {
  value?: unknown
  get?: (this: unknown) => unknown
}

function isRetirementObservedObject(value: unknown): value is RetirementObservedObject {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

export function readRetirementProperty(
  target: unknown,
  key: PropertyKey,
  receiver: unknown
): unknown {
  for (
    let current = target;
    isRetirementObservedObject(current);
    current = Object.getPrototypeOf(current)
  ) {
    const property: RetirementObservedProperty | undefined = Object.getOwnPropertyDescriptor(
      current,
      key
    )
    if (property) {
      return property.get ? property.get.call(receiver) : property.value
    }
  }
  return undefined
}

export function graph(value: unknown): unknown {
  const seen = new Map<object, string>()
  const visit = (entry: unknown, path: string): unknown => {
    if (!isRetirementObservedObject(entry) || typeof entry === 'function') {
      return entry
    }
    const prior = seen.get(entry)
    if (prior !== undefined) {
      return { alias: prior }
    }
    seen.set(entry, path)
    const proto = Object.getPrototypeOf(entry)
    return {
      prototype:
        proto === Object.prototype
          ? 'object'
          : proto === Array.prototype
            ? 'array'
            : proto === null
              ? 'null'
              : Object.keys(proto),
      fields: Object.keys(entry).map((key) => [key, visit(entry[key], `${path}.${key}`)])
    }
  }
  return visit(value, '$')
}

// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { create } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status-types'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../../../shared/worktree/card-properties'
import { makePaneKey } from '../../../../../../shared/stable-pane-id'
import type { selectWorktreeAgentRowCandidateIds } from '../../worktree-agent-row-selectors'
import { getLiveEntriesFullRebuildCountForTests } from '../../worktree-agent-live-index-patch'
import { useSidebarCardGeometryInputs } from './use-sidebar-card-geometry-inputs'
import { buildSidebarGeometry, type SidebarGeometry } from '../listing/sidebar-geometry-slots'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'

type State = Parameters<typeof selectWorktreeAgentRowCandidateIds>[0] &
  Pick<
    AppState,
    'worktreeCardProperties' | 'gitConflictOperationByWorktree' | 'remoteBranchConflictByWorktreeId'
  >
const initial = (): State => ({
  tabsByWorktree: {},
  agentStatusByPaneKey: {},
  retainedAgentsByPaneKey: {},
  migrationUnsupportedByPtyId: {},
  worktreeCardProperties: DEFAULT_WORKTREE_CARD_PROPERTIES,
  gitConflictOperationByWorktree: {},
  remoteBranchConflictByWorktreeId: {}
})
const useGeometryStore = create<State>(initial)
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: State) => T) => useGeometryStore(selector)
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let element: HTMLDivElement
let root: Root
let builds = 0
let model: SidebarGeometry
const rows = [lineageRow('a', 0), lineageRow('b', 0)]
const pane = makePaneKey('tab', '11111111-1111-4111-8111-111111111111')
const entry: AgentStatusEntry = {
  paneKey: pane,
  worktreeId: 'a',
  state: 'working',
  agentType: 'codex',
  stateStartedAt: 1,
  updatedAt: 1,
  stateHistory: [],
  prompt: 'one',
  terminalTitle: undefined,
  interrupted: false
}
function Probe({
  compact = false,
  empty = false,
  newStyle = true
}: {
  compact?: boolean
  empty?: boolean
  newStyle?: boolean
}) {
  const resolver = useSidebarCardGeometryInputs({
    newCardStyle: newStyle,
    compactPreference: compact,
    hasProjectGroups: false,
    hideRepoBadge: false,
    hasCardCandidates: !empty
  })
  model = useMemo(() => {
    builds++
    return buildSidebarGeometry(empty ? [] : rows, resolver)
  }, [resolver, empty])
  return null
}
beforeEach(() => {
  useGeometryStore.setState(initial(), true)
  builds = 0
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  element.remove()
})

describe('memoized sidebar shape inputs', () => {
  it('rebuilds only on shape membership changes, including when renderRows stays unchanged', async () => {
    await act(async () => root.render(<Probe />))
    expect(model.slots[0]!.estimate).toBe(39)
    const initialBuilds = builds
    await act(async () => useGeometryStore.setState({ agentStatusByPaneKey: { [pane]: entry } }))
    expect(builds).toBe(initialBuilds + 1)
    expect(model.nodes[0]!.cardGeometry).toBeNull()
    for (let index = 0; index < 10; index++) {
      await act(async () =>
        useGeometryStore.setState({
          agentStatusByPaneKey: {
            [pane]: { ...entry, updatedAt: index + 2, prompt: String(index) }
          }
        })
      )
    }
    expect(builds).toBe(initialBuilds + 1)
    await act(async () => useGeometryStore.setState({ agentStatusByPaneKey: {} }))
    expect(builds).toBe(initialBuilds + 2)
    expect(model.slots[0]!.estimate).toBe(39)
    await act(async () =>
      useGeometryStore.setState({ gitConflictOperationByWorktree: { a: 'rebase' } })
    )
    expect(builds).toBe(initialBuilds + 2)
    await act(async () =>
      useGeometryStore.setState({ gitConflictOperationByWorktree: { a: 'merge' } })
    )
    expect(builds).toBe(initialBuilds + 3)
    await act(async () =>
      useGeometryStore.setState({ gitConflictOperationByWorktree: { a: 'cherry-pick' } })
    )
    expect(builds).toBe(initialBuilds + 3)
  })
  it.each(['compact', 'inline-disabled', 'empty'] as const)(
    'does not activate agent indexes for %s',
    async (mode) => {
      useGeometryStore.setState({
        agentStatusByPaneKey: { [pane]: entry },
        ...(mode === 'inline-disabled' ? { worktreeCardProperties: ['status'] as const } : {})
      })
      const count = getLiveEntriesFullRebuildCountForTests()
      await act(async () =>
        root.render(
          <Probe
            compact={mode === 'compact'}
            newStyle={mode !== 'compact'}
            empty={mode === 'empty'}
          />
        )
      )
      expect(getLiveEntriesFullRebuildCountForTests()).toBe(count)
      for (let index = 0; index < 5; index++) {
        await act(async () =>
          useGeometryStore.setState({
            agentStatusByPaneKey: { [pane]: { ...entry, updatedAt: index + 2 } }
          })
        )
      }
      expect(getLiveEntriesFullRebuildCountForTests()).toBe(count)
      expect(builds).toBe(1)
    }
  )
})

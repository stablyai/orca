// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  resetAttentionWorkspaceIdsForTests,
  useAttentionWorkspaceIds
} from './use-attention-workspace-ids'

const PANE = makePaneKey('tab-unmirrored', '33333333-3333-4333-8333-333333333333')
const originalState = useAppStore.getState()

let root: Root | null = null
let container: HTMLDivElement | null = null
let renders = 0
let lastIds: ReadonlySet<string> | null = null

function Probe(): null {
  renders += 1
  lastIds = useAttentionWorkspaceIds(true)
  return null
}

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<Probe />))
}

function entry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  const now = Date.now()
  return {
    state: 'working',
    prompt: 'do the thing',
    updatedAt: now,
    stateStartedAt: now,
    stateHistory: [],
    agentType: 'claude',
    paneKey: PANE,
    tabId: 'tab-unmirrored',
    worktreeId: 'w1',
    ...overrides
  }
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
  renders = 0
  lastIds = null
  useAppStore.setState(originalState, true)
  resetAttentionWorkspaceIdsForTests()
})

describe('useAttentionWorkspaceIds store subscription', () => {
  it('does not re-render the subscriber while status writes leave the verdict unchanged', () => {
    mount()
    const initial = lastIds
    expect(renders).toBe(1)

    for (let i = 0; i < 3; i += 1) {
      act(() => {
        useAppStore.setState({
          agentStatusByPaneKey: { [PANE]: entry({ prompt: `prompt ${i}` }) }
        })
      })
    }

    expect(renders).toBe(1)
    expect(lastIds).toBe(initial)
  })

  it('re-renders once a write changes the verdict', () => {
    mount()

    act(() => {
      useAppStore.setState({ agentStatusByPaneKey: { [PANE]: entry({ state: 'waiting' }) } })
    })

    expect(renders).toBe(2)
    expect(lastIds ? [...lastIds] : null).toEqual(['w1'])
  })
})

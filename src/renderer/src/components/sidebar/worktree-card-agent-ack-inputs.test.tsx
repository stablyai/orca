/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { create } from 'zustand'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import { useShallow } from 'zustand/react/shallow'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentRowUnreadState } from '@/components/dashboard/dashboard-row-bucket'
import { selectAgentRowsUnread } from './worktree-card-agent-ack-inputs'

const AGENTS = [{ paneKey: 'tab-a:leaf-a' }, { paneKey: 'tab-a:leaf-b' }] as const

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TURNS = {
  'tab-a:leaf-a': { stateStartedAt: 10 },
  'tab-a:leaf-b': { stateStartedAt: 20 }
}

function unreadState(acknowledgedAgentsByPaneKey: Record<string, number>): AgentRowUnreadState {
  return {
    agentStatusByPaneKey: TURNS,
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey
  }
}

const useAckStore = create<AgentRowUnreadState>(() => unreadState({}))

let renderCount = 0
let selectedTimes: readonly boolean[] | undefined

function SelectionProbe({ agents }: { agents: readonly Pick<DashboardAgentRow, 'paneKey'>[] }) {
  selectedTimes = useAckStore(useShallow((state) => selectAgentRowsUnread(state, agents)))
  renderCount += 1
  return null
}

describe('selectAgentRowsUnread', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    useAckStore.setState(unreadState({}))
    renderCount = 0
    selectedTimes = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<SelectionProbe agents={AGENTS} />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('projects only this card rows so unrelated acknowledgements stay shallow-equal', () => {
    const initialTimes = selectedTimes

    act(() => {
      useAckStore.setState(unreadState({ 'tab-other:leaf': 99 }))
    })

    expect(renderCount).toBe(1)
    expect(selectedTimes).toBe(initialTimes)

    const before = selectAgentRowsUnread(
      unreadState({ 'tab-a:leaf-a': 10, 'tab-a:leaf-b': 20 }),
      AGENTS
    )
    const after = selectAgentRowsUnread(
      unreadState({ 'tab-a:leaf-a': 10, 'tab-a:leaf-b': 20, 'tab-other:leaf': 99 }),
      AGENTS
    )

    expect(after).toEqual(before)
    expect(shallow(after, before)).toBe(true)
  })

  it('updates when one of this card rows is acknowledged', () => {
    const initialTimes = selectedTimes
    act(() => {
      useAckStore.setState(unreadState({ 'tab-a:leaf-a': 11 }))
    })
    expect(renderCount).toBe(2)
    expect(selectedTimes).not.toBe(initialTimes)
    expect(selectedTimes).toEqual([false, true])

    const before = selectAgentRowsUnread(unreadState({ 'tab-a:leaf-a': 9 }), AGENTS)
    const after = selectAgentRowsUnread(unreadState({ 'tab-a:leaf-a': 11 }), AGENTS)

    expect(after).toEqual([false, true])
    expect(shallow(after, before)).toBe(false)
  })
})

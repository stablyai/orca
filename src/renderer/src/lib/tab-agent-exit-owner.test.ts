import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import * as tabSignals from './tab-agent'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getTabAgentObservation, startTabAgentExitOwner } from './tab-agent-exit-owner'
const initial = useAppStore.getInitialState()
const leaf = '11111111-1111-4111-8111-111111111111'
const pane = makePaneKey('tab', leaf)
const tab: TerminalTab = {
  id: 'tab',
  worktreeId: 'repo::/root-evidence',
  ptyId: 'pty-a',
  title: 'codex',
  launchAgent: 'codex',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}
let stop: (() => void) | undefined
function seed(pty = 'pty-a'): void {
  useAppStore.setState(
    {
      ...initial,
      tabsByWorktree: { [tab.worktreeId]: [tab] },
      ptyIdsByTabId: { tab: [pty] },
      terminalLayoutsByTabId: {
        tab: {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: pty }
        }
      }
    },
    true
  )
}
afterEach(() => {
  stop?.()
  stop = undefined
  useAppStore.setState(initial, true)
})
describe('root agent exit evidence without tab chrome', () => {
  it('clears on observed local shell return and settles its reentrant store mutation once', () => {
    seed()
    const clear = vi.fn(initial.clearTabLaunchAgent)
    useAppStore.setState({ clearTabLaunchAgent: clear })
    stop = startTabAgentExitOwner()
    useAppStore.setState({
      paneForegroundAgentByPaneKey: { [pane]: { agent: null, shellForeground: true } }
    })
    expect(useAppStore.getState().tabsByWorktree[tab.worktreeId][0].launchAgent).toBeUndefined()
    expect(clear).toHaveBeenCalledTimes(1)
    useAppStore.setState({ sortEpoch: 1 })
    expect(clear).toHaveBeenCalledTimes(1)
  })
  it.each([10, 100])('inspects only the affected agent bucket across %i workspaces', (count) => {
    const tabsByWorktree: Record<string, TerminalTab[]> = {}
    for (let n = 0; n < count; n += 1) {
      tabsByWorktree[`workspace-${n}`] = [{ ...tab, id: `tab-${n}`, worktreeId: `workspace-${n}` }]
    }
    useAppStore.setState({ ...initial, tabsByWorktree }, true)
    stop = startTabAgentExitOwner()
    const inspect = vi.spyOn(tabSignals, 'resolveFocusedTabAgent')
    useAppStore.setState({ sortEpoch: 1 })
    expect(inspect).not.toHaveBeenCalled()
    useAppStore.setState({
      tabsByWorktree: {
        ...tabsByWorktree,
        'workspace-0': [{ ...tabsByWorktree['workspace-0'][0], title: 'codex working' }]
      }
    })
    expect(inspect).toHaveBeenCalledTimes(1)
    inspect.mockRestore()
  })
  it('does not borrow observed activity across a respawn or remote transport loss', () => {
    seed()
    stop = startTabAgentExitOwner()
    useAppStore.setState({
      tabsByWorktree: { [tab.worktreeId]: [{ ...tab, title: 'zsh' }] },
      ptyIdsByTabId: { tab: ['pty-b'] },
      terminalLayoutsByTabId: {
        tab: {
          root: null,
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-b' }
        }
      },
      paneForegroundAgentByPaneKey: { [pane]: { agent: null, shellForeground: true } }
    })
    expect(getTabAgentObservation(tab.id)).toBe(false)
    expect(useAppStore.getState().tabsByWorktree[tab.worktreeId][0].launchAgent).toBe('codex')
    stop()
    seed('remote:environment:pty')
    stop = startTabAgentExitOwner()
    useAppStore.setState({ tabsByWorktree: { [tab.worktreeId]: [{ ...tab, title: 'zsh' }] } })
    expect(useAppStore.getState().tabsByWorktree[tab.worktreeId][0].launchAgent).toBe('codex')
    useAppStore.setState({ tabsByWorktree: {} })
    expect(getTabAgentObservation(tab.id)).toBe(false)
  })
})

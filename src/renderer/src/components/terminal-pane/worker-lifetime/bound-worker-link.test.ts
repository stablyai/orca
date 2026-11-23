import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { boundWorkerLink, findBoundWorkerTab } from './bound-worker-link'

const worktreeId = 'repo::/wt/child'
const workerPane = 'tab-worker:11111111-1111-4111-8111-111111111111'
const boundTo = { paneKey: workerPane, worktreeId, name: 'Fix the parser', agent: 'claude' }

function tab(id: string, title: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('the worker a bound terminal names', () => {
  it("links to the worker's own pane, named as its tab shows it", () => {
    const workerTab = tab('tab-worker', 'parser fix')
    const tabs = { [worktreeId]: [tab('tab-setup', 'Setup'), workerTab] }
    const link = boundWorkerLink(boundTo, findBoundWorkerTab(tabs, boundTo), 'its worker')
    expect(link).toEqual({
      name: 'parser fix',
      tab: workerTab,
      reveal: { worktreeId, paneKey: workerPane }
    })
  })

  it("is plain text once the worker's terminal is gone", () => {
    expect(
      boundWorkerLink(
        boundTo,
        findBoundWorkerTab({ [worktreeId]: [tab('tab-setup', 'Setup')] }, boundTo),
        'its worker'
      )
    ).toEqual({
      name: 'Fix the parser',
      reveal: null
    })
  })

  it('names the paired server whose workspace it focuses', () => {
    const workerTab = tab('tab-worker', 'parser fix')
    const tabs = { [worktreeId]: [workerTab] }
    expect(
      boundWorkerLink(boundTo, findBoundWorkerTab(tabs, boundTo), 'its worker', 'env-1').reveal
    ).toEqual({ worktreeId, paneKey: workerPane, hostId: 'runtime:env-1' })
  })
})

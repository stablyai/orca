import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CompactAgentRow } from '../../../src/renderer/src/components/sidebar/worktree-card-compact-agent-row'
import { buildWorktreeAgentRows } from '../../../src/renderer/src/components/sidebar/worktree-agent-rows'
import { selectLiveAgentStatusEntriesForWorktree } from '../../../src/renderer/src/components/sidebar/worktree-agent-row-selectors'
import type { WorktreeAgentRowsState } from '../../../src/renderer/src/components/sidebar/worktree-agent-row-selectors'
import { makePaneKey } from '../../../src/shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../src/shared/terminal-surface-id'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import './fixture.css'

const now = Date.now()
const worktreeId = 'folder:remote-project'
const state: WorktreeAgentRowsState = {
  agentStatusByPaneKey: {},
  tabsByWorktree: {},
  unifiedTabsByWorktree: {},
  retainedAgentsByPaneKey: {},
  migrationUnsupportedByPtyId: {}
}
for (const [tabId, connectionId, prompt] of [
  [toWebTerminalSurfaceTabId('paired'), undefined, 'Paired OMP finished the change'],
  ['ssh-tab', 'ssh-host', 'SSH OMP finished the change'],
  ['local-tab', undefined, 'Local completed orphan']
] as const) {
  const paneKey = makePaneKey(tabId, '11111111-1111-4111-8111-111111111111')
  state.agentStatusByPaneKey[paneKey] = {
    paneKey,
    tabId,
    worktreeId,
    connectionId,
    state: 'done',
    agentType: 'omp',
    prompt,
    updatedAt: now,
    stateStartedAt: now,
    stateHistory: []
  }
}
function Fixture() {
  const [retracted, setRetracted] = useState(false)
  Object.assign(window, { sidebarProof: { retract: () => setRetracted(true) } })
  const current = retracted ? { ...state, agentStatusByPaneKey: {} } : state
  const rows = buildWorktreeAgentRows({
    tabs: [],
    entries: selectLiveAgentStatusEntriesForWorktree(current, worktreeId),
    retained: [],
    now
  })
  return (
    <main className="h-screen bg-background p-4 text-foreground">
      <aside className="w-80 rounded-md border border-border bg-sidebar p-3" data-worktree-sidebar>
        <h1 className="mb-3 text-sm font-semibold">remote-project</h1>
        {rows.map((agent) => (
          <CompactAgentRow
            key={agent.paneKey}
            agent={agent}
            now={now}
            onActivate={() => {}}
            cacheTimerActive={false}
          />
        ))}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent activity</p>
        ) : null}
      </aside>
    </main>
  )
}
const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>
)

import { defineFixture } from '../../../../component-fixtures/component-fixture'
import WorktreeCardAgents from './WorktreeCardAgents'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

export const nativeTitle = defineFixture({
  width: 340,
  store: { agentActivityDisplayMode: 'full' },
  render: () => (
    <div className="bg-sidebar p-2 text-sidebar-foreground">
      <div className="text-sm">main</div>
      <WorktreeCardAgents
        worktreeId="prime-fixture"
        agents={buildWorktreeAgentRows({
          tabs: [
            {
              id: 'prime-tab',
              worktreeId: 'prime-fixture',
              ptyId: 'prime-pty',
              title: 'prime-agent - workspace',
              defaultTitle: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ],
          entries: [],
          retained: [],
          ptyIdsByTabId: { 'prime-tab': ['prime-pty'] },
          terminalLayoutsByTabId: {
            'prime-tab': {
              root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
              activeLeafId: '11111111-1111-4111-8111-111111111111',
              expandedLeafId: null
            }
          },
          now: 1_000
        })}
      />
    </div>
  )
})

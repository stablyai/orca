import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { AiVaultSessionVirtualList } from '../../../src/renderer/src/components/right-sidebar/AiVaultSessionVirtualList'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import './fixture.css'

const parent: AiVaultSession = {
  id: 'parent',
  agent: 'omp',
  executionHostId: 'local',
  sessionId: 'parent',
  title: 'Coordinate the change',
  cwd: '/project',
  branch: null,
  model: null,
  filePath: '/sessions/parent.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-09-14T00:00:00Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 3,
  resumeCommand: 'omp --resume parent',
  subagent: null
}

const children: AiVaultSession[] = [
  {
    ...parent,
    id: 'child',
    sessionId: 'child',
    title: 'OMP worker with saved conversation',
    filePath: '/sessions/parent/child.jsonl',
    subagentTranscriptCount: 1,
    subagent: { parentSessionId: 'parent', agentType: 'worker', status: 'completed' }
  },
  {
    ...parent,
    id: 'claude',
    agent: 'claude',
    filePath: '/sessions/parent/claude.jsonl',
    subagentTranscriptCount: 0,
    title: 'Claude worker (view only)',
    subagent: { parentSessionId: 'parent', agentType: 'worker', status: 'completed' }
  },
  {
    ...parent,
    id: 'empty',
    sessionId: 'empty',
    filePath: '/sessions/parent/empty.jsonl',
    subagentTranscriptCount: 0,
    messageCount: 0,
    title: 'OMP worker without saved turns',
    subagent: { parentSessionId: 'parent', agentType: 'worker', status: 'stopped' }
  }
]

const descendants = Array.from({ length: 7 }, (_, index): AiVaultSession => ({
  ...parent,
  id: `depth-${index}`,
  sessionId: `depth-${index}`,
  filePath: `/sessions/parent/child/${Array.from({ length: index + 1 }, () => 'nested').join('/')}.jsonl`,
  title: `Research depth ${index + 2}`,
  subagentTranscriptCount: index === 6 ? 0 : 1,
  subagent: { parentSessionId: 'child', agentType: 'researcher', status: 'completed' }
}))

const requests: string[] = []

Object.defineProperty(window, 'nestedRequests', { value: requests })

Object.defineProperty(window, 'api', {
  value: {
    aiVault: {
      listSubagentSessions: async ({ parentFilePath }: { parentFilePath: string }) => {
        requests.push(parentFilePath)
        await new Promise((resolve) => setTimeout(resolve, 250))
        const index = descendants.findIndex((session) => session.filePath === parentFilePath)

        return {
          sessions:
            parentFilePath === parent.filePath
              ? children
              : parentFilePath === children[0].filePath
                ? [descendants[0]]
                : index !== -1
                  ? descendants.slice(index + 1, index + 2)
                  : [],
          issues: []
        }
      }
    }
  }
})

const sessions = [
  parent,
  ...Array.from({ length: 100 }, (_, index) => ({
    ...parent,
    id: `row-${index}`,
    sessionId: `row-${index}`,
    title: `Other session ${index}`,
    filePath: `/sessions/other-${index}.jsonl`,
    subagentTranscriptCount: 0
  }))
]

const ignore = () => {}

function App() {
  const [result, setResult] = useState('No resume requested')

  return (
    <TooltipProvider>
      <main className="p-6 bg-background text-foreground space-y-4">
        <h1>Agent Session History</h1>
        <div data-testid="history-panel" className="h-[600px] flex flex-col border border-border">
          <AiVaultSessionVirtualList
            groups={[{ key: 'project', label: 'Project', sessions }]}
            collapsedGroups={new Set()}
            loading={false}
            sessionsCount={sessions.length}
            filteredSessionsCount={sessions.length}
            noAgentsSelected={false}
            error={null}
            vaultScope="all"
            buildResumeStartup={(session) => ({ command: session.resumeCommand })}
            getOriginalPaneTarget={() => null}
            getSessionLiveState={() => null}
            getWorktreeInfo={() => null}
            getSessionResumeState={() => ({
              blocked: false,
              worktreeId: 'folder:project',
              usesSessionWorktree: true
            })}
            getSessionResumeActions={() => ({
              worktree: { worktreeId: 'folder:project', disabled: false },
              newTab: { worktreeId: 'folder:project', disabled: false }
            })}
            getSessionResumeInChat={() => ({ available: false, reason: 'agent' })}
            onToggleGroup={ignore}
            onJumpToOriginalPane={ignore}
            onJumpToWorktree={ignore}
            onResume={(session, target) => setResult(`Resume ${session.sessionId} in ${target}`)}
            onContinueInNewSession={ignore}
            onResumeInNewChat={ignore}
            onCopyResume={ignore}
            onCopyId={ignore}
            onCopyPath={ignore}
            onOpenLog={ignore}
            onRevealLog={ignore}
            onOpenCwd={ignore}
            onRequestDelete={ignore}
          />
        </div>
        <output>{result}</output>
      </main>
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

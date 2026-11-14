import { useState } from 'react'
import { defineFixture } from '@/component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { VaultHostScopeMenu } from '../panel/AiVaultPanelControls'
import { useAiVaultExecutionHostScope } from './ai-vault-host-scope'

const workspaceId = 'acme::/projects/acme/app'
const hostId = 'runtime:fixture-server' as const
const resumeTargetState = {
  folderWorkspaces: [],
  projectGroups: [],
  repos: [{ ...TEST_REPO, id: 'acme', executionHostId: hostId }],
  worktreesByRepo: {
    acme: [makeWorktree({ id: workspaceId, repoId: 'acme', hostId })]
  }
}
const availableExecutionHostScopes = [hostId]
const hostOptions = [
  { id: 'local' as const, label: 'Local Windows' },
  { id: hostId, label: 'MacBook' },
  { id: 'all' as const, label: 'All hosts' }
]

function HostScopeReproduction(): React.JSX.Element {
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(workspaceId)
  const { executionHostScope, onExecutionHostScopeChange } = useAiVaultExecutionHostScope({
    activeWorktreeId,
    resumeTargetState,
    availableExecutionHostScopes
  })
  return (
    <section className="@container/ai-vault space-y-4 rounded-xl border bg-card p-4 text-card-foreground">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Project chats</h2>
        <VaultHostScopeMenu
          executionHostScope={executionHostScope}
          hostOptions={hostOptions}
          onExecutionHostScopeChange={onExecutionHostScopeChange}
        />
      </div>
      <p className="text-xs text-muted-foreground">Host scope reproduction · synthetic workspace</p>
      <p className="text-sm">
        {activeWorktreeId ? 'Remote workspace selected' : 'No active workspace'}
      </p>
      <Button variant="outline" onClick={() => setActiveWorktreeId(null)}>
        Clear active workspace
      </Button>
    </section>
  )
}

export const selected = defineFixture({ width: 560, render: () => <HostScopeReproduction /> })
export const cleared = defineFixture({
  width: 560,
  render: () => <HostScopeReproduction />,
  interact: (frame) => {
    const button = [...frame.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Clear active workspace'
    )
    if (!button) {
      throw new Error('Workspace clear action missing')
    }
    button.click()
  }
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddRepoDialogStepContent } from './AddRepoDialogStepContent'
import type { NestedRepoScanResult } from '../../../../shared/types'

const nestedScan: NestedRepoScanResult = {
  selectedPath: '/workspace/platform',
  selectedPathKind: 'non_git_folder',
  repos: [
    { path: '/workspace/platform/api', displayName: 'api', depth: 1 },
    { path: '/workspace/platform/cli', displayName: 'cli', depth: 1 }
  ],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 5,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: null
}

function renderNestedStep(repoCount: number): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Dialog open>
        <AddRepoDialogStepContent
          step="nested"
          isRuntimeEnvironmentActive={false}
          repoCount={repoCount}
          isAdding={false}
          addProjectBusyLabel={null}
          nestedScanInProgress={false}
          nestedScanId={null}
          serverPath=""
          isAddingServerPath={false}
          cloneUrl=""
          cloneDestination=""
          cloneError={null}
          cloneProgress={null}
          isCloning={false}
          sshTargets={[]}
          selectedTargetId={null}
          remotePath=""
          remoteError={null}
          isAddingRemote={false}
          isScanningRemoteNested={false}
          nestedScan={nestedScan}
          nestedSelectedPaths={new Set(nestedScan.repos.map((repo) => repo.path))}
          nestedGroupName="platform"
          createName=""
          createParent=""
          createKind="git"
          createError={null}
          isCreating={false}
          onBrowse={vi.fn()}
          onOpenCloneStep={vi.fn()}
          onOpenCreateStep={vi.fn()}
          onOpenRemoteStep={vi.fn()}
          onStopNestedScan={vi.fn()}
          onServerPathChange={vi.fn()}
          onAddServerPath={vi.fn()}
          onSelectTarget={vi.fn()}
          onRemotePathChange={vi.fn()}
          onAddRemoteRepo={vi.fn()}
          onOpenSshSettings={vi.fn()}
          onConnectTarget={vi.fn()}
          onStopRemoteNestedScan={vi.fn()}
          onCloneUrlChange={vi.fn()}
          onCloneDestinationChange={vi.fn()}
          onPickCloneDestination={vi.fn()}
          onClone={vi.fn()}
          onNestedGroupNameChange={vi.fn()}
          onNestedSelectedPathsChange={vi.fn()}
          onImportNestedRepos={vi.fn()}
          onCreateNameChange={vi.fn()}
          onCreateParentChange={vi.fn()}
          onCreateKindChange={vi.fn()}
          onPickCreateParent={vi.fn()}
          onCreate={vi.fn()}
        />
      </Dialog>
    </TooltipProvider>
  )
}

describe('AddRepoDialogStepContent nested imports', () => {
  it('uses the first-import nested repo action when no repos exist yet', () => {
    const html = renderNestedStep(0)

    expect(html).toContain('>Import</button>')
    expect(html).not.toContain('Import as group')
    expect(html).not.toContain('Import separately')
    expect(html).not.toContain('aria-label="Group name"')
  })

  it('shows group import controls after a repo already exists', () => {
    const html = renderNestedStep(1)

    expect(html).toContain('aria-label="Group name"')
    expect(html).toContain('Import separately')
    expect(html).toContain('Import as group')
    expect(html).not.toContain('>Import</button>')
  })
})

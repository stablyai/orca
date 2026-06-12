import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
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

type StepContentProps = ComponentProps<typeof AddRepoDialogStepContent>

function renderStepContent(overrides: Partial<StepContentProps>): string {
  const props: StepContentProps = {
    step: 'nested',
    isRuntimeEnvironmentActive: false,
    activeRuntimeEnvironmentId: null,
    isSshLikely: false,
    repoCount: 1,
    isAdding: false,
    addProjectBusyLabel: null,
    nestedScanInProgress: false,
    nestedScanId: null,
    serverPath: '',
    isAddingServerPath: false,
    cloneUrl: '',
    cloneDestination: '',
    cloneError: null,
    cloneProgress: null,
    isCloning: false,
    sshTargets: [],
    selectedTargetId: null,
    remotePath: '',
    remoteError: null,
    isAddingRemote: false,
    isScanningRemoteNested: false,
    nestedScan,
    nestedSelectedPaths: new Set(nestedScan.repos.map((repo) => repo.path)),
    nestedGroupName: 'platform',
    createName: '',
    createParent: '',
    createError: null,
    isCreating: false,
    createDefaultParent: '',
    createGitAvailability: 'unknown',
    createRuntimeParentStatus: 'idle',
    createParentDefaultPending: false,
    onBrowse: vi.fn(),
    onOpenCloneStep: vi.fn(),
    onOpenCreateStep: vi.fn(),
    onOpenRemoteStep: vi.fn(),
    onStopNestedScan: vi.fn(),
    onServerPathChange: vi.fn(),
    onAddServerPath: vi.fn(),
    onSelectTarget: vi.fn(),
    onRemotePathChange: vi.fn(),
    onAddRemoteRepo: vi.fn(),
    onOpenSshSettings: vi.fn(),
    onConnectTarget: vi.fn(),
    onStopRemoteNestedScan: vi.fn(),
    onCloneUrlChange: vi.fn(),
    onCloneDestinationChange: vi.fn(),
    onPickCloneDestination: vi.fn(),
    onClone: vi.fn(),
    onNestedGroupNameChange: vi.fn(),
    onNestedSelectedPathsChange: vi.fn(),
    onImportNestedRepos: vi.fn(),
    onCreateNameChange: vi.fn(),
    onCreateParentChange: vi.fn(),
    onPickCreateParent: vi.fn(),
    onCreate: vi.fn(),
    ...overrides
  }

  return renderToStaticMarkup(
    <TooltipProvider>
      <Dialog open>
        <AddRepoDialogStepContent {...props} />
      </Dialog>
    </TooltipProvider>
  )
}

function renderNestedStep(repoCount: number): string {
  return renderStepContent({ repoCount })
}

describe('AddRepoDialogStepContent nested imports', () => {
  it('asks the monorepo question when no repos exist yet', () => {
    const html = renderNestedStep(0)

    expect(html).toContain('Is this a monorepo?')
    expect(html).toContain('aria-label="Group name"')
    expect(html).toContain('Import as group')
    expect(html).toContain('No, import separately')
    expect(html).not.toContain('>Import</button>')
  })

  it('shows the same monorepo import controls after a repo already exists', () => {
    const html = renderNestedStep(1)

    expect(html).toContain('Is this a monorepo?')
    expect(html).toContain('aria-label="Group name"')
    expect(html).toContain('Import as group')
    expect(html).toContain('No, import separately')
    expect(html).not.toContain('>Import</button>')
  })

  it('offers server browsing for remote create project locations', () => {
    const html = renderStepContent({
      step: 'create',
      isRuntimeEnvironmentActive: true,
      activeRuntimeEnvironmentId: 'env-1'
    })

    expect(html).toContain('Create project')
    expect(html).toContain('Choose or enter a server parent folder before creating.')
    expect(html).toContain('Browse')
  })

  it('offers server browsing for remote clone destinations', () => {
    const html = renderStepContent({
      step: 'clone',
      isRuntimeEnvironmentActive: true,
      activeRuntimeEnvironmentId: 'env-1'
    })

    expect(html).toContain('Clone from URL')
    expect(html).toContain('aria-label="Browse server filesystem"')
  })
})

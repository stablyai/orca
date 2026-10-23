import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddRepoDialogStepContent } from './AddRepoDialogStepContent'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'

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
    onConnectTarget: vi.fn(),
    onCloneUrlChange: vi.fn(),
    onCloneDestinationChange: vi.fn(),
    onPickCloneDestination: vi.fn(),
    onClone: vi.fn(),
    onNestedGroupNameChange: vi.fn(),
    onNestedSelectedPathsChange: vi.fn(),
    onImportNestedRepos: vi.fn(),
    onOpenNestedRootFolder: vi.fn(),
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
  it('asks the grouping question when no repos exist yet', () => {
    const html = renderNestedStep(0)

    expect(html).toContain('Group these repositories?')
    expect(html).toContain('aria-label="Group name"')
    expect(html).toContain('Yes, import as group')
    expect(html).toContain('No, import separately')
    expect(html).not.toContain('>Import</button>')
  })

  it('shows the same grouping import controls after a repo already exists', () => {
    const html = renderNestedStep(1)

    expect(html).toContain('Group these repositories?')
    expect(html).toContain('aria-label="Group name"')
    expect(html).toContain('Yes, import as group')
    expect(html).toContain('No, import separately')
    expect(html).not.toContain('>Import</button>')
  })

  it('offers opening the parent folder when nested import selection is empty', () => {
    const html = renderStepContent({ nestedSelectedPaths: new Set() })

    expect(html).toContain('No repositories are selected')
    expect(html).toContain('Open as Folder')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>No, import separately<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Yes, import as group<\/button>/)
  })

  it('offers host browsing for remote create project locations', () => {
    const html = renderStepContent({
      step: 'create',
      isRuntimeEnvironmentActive: true,
      activeRuntimeEnvironmentId: 'env-1'
    })

    expect(html).toContain('Create a new project')
    expect(html).toContain('host folder not selected')
  })

  // Regression: a path left filled from an earlier pick on an SSH or paired host still browses.
  it('opens the host browser for a filled path that Windows did not hand over', () => {
    const remote = {
      step: 'server-path' as const,
      isRuntimeEnvironmentActive: true,
      activeRuntimeEnvironmentId: 'env-1',
      serverPath: '/home/me/app'
    }
    const browser = 'Navigate to a directory and click Select to choose it.'
    expect(renderStepContent(remote)).toContain(browser)
    expect(renderStepContent({ ...remote, serverPathPrefilled: true })).not.toContain(browser)
  })

  it('offers host browsing for remote clone destinations', () => {
    const html = renderStepContent({
      step: 'clone',
      isRuntimeEnvironmentActive: true,
      activeRuntimeEnvironmentId: 'env-1'
    })

    expect(html).toContain('Clone from URL')
    expect(html).toContain('aria-label="Browse host filesystem"')
  })

  it('falls back to the start step when no paired server reaches the SSH hosts', () => {
    const html = renderStepContent({ step: 'remote', selectedTargetId: 'openclaw-2' })

    expect(html).toContain('Browse folder')
    expect(html).not.toContain('Host path')
  })

  it('uses the standard add step for remote Orca server hosts', () => {
    const html = renderStepContent({
      step: 'add',
      isRuntimeEnvironmentActive: true,
      activeRuntimeEnvironmentId: 'env-1',
      browseHostKind: 'runtime'
    })

    expect(html).toContain('Browse folder')
    expect(html).toContain('Existing Git repository or folder on this host')
    expect(html).toContain('Clone from URL')
    expect(html).toContain('Create new project')
    expect(html).not.toContain('Browse host')
    expect(html).not.toContain('Create on host')
    expect(html).not.toContain('Want to import many repos at once?')
  })

  it('opens the in-app filesystem browser for a paired runtime', () => {
    const html = renderStepContent({
      step: 'server-path',
      isRuntimeEnvironmentActive: true,
      activeRuntimeEnvironmentId: 'paired-host'
    })

    expect(html).toContain('Browse host filesystem')
    expect(html).toContain('Navigate to a directory and click Select to choose it.')
    expect(html).toContain('Select folder')
  })
})

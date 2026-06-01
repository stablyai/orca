import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RepoStep } from './RepoStep'
import { TooltipProvider } from '../ui/tooltip'

function renderRepoStep(overrides: Partial<ComponentProps<typeof RepoStep>> = {}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RepoStep
        cloneUrl=""
        onCloneUrlChange={vi.fn()}
        nestedScan={null}
        nestedSelectedPaths={new Set()}
        onNestedSelectedPathsChange={vi.fn()}
        nestedGroupName=""
        onNestedGroupNameChange={vi.fn()}
        onImportNested={vi.fn()}
        onCancelNested={vi.fn()}
        onStopNestedScan={vi.fn()}
        nestedScanInProgress={false}
        onOpenFolder={vi.fn()}
        onOpenServerFolder={vi.fn()}
        onClone={vi.fn()}
        onOpenSshSettings={vi.fn()}
        serverPath=""
        onServerPathChange={vi.fn()}
        cloneDestination=""
        onCloneDestinationChange={vi.fn()}
        workspaceDir="/workspace"
        runtimeActive={false}
        busyLabel={null}
        error={null}
        {...overrides}
      />
    </TooltipProvider>
  )
}

describe('RepoStep', () => {
  it('renders the add project options without existing-project chrome', () => {
    const html = renderRepoStep()

    expect(html).not.toContain('Project already added')
    expect(html).toContain('Open a folder')
    expect(html).toContain('Clone a repo')
  })

  it('disables nested import actions when no repositories are selected', () => {
    const html = renderRepoStep({
      nestedScan: {
        selectedPath: '/workspace/platform',
        selectedPathKind: 'non_git_folder',
        repos: [{ path: '/workspace/platform/apps/web', displayName: 'web', depth: 2 }],
        truncated: false,
        timedOut: false,
        stopped: false,
        durationMs: 4,
        maxDepth: 3,
        maxRepos: 100,
        timeoutMs: null
      },
      nestedGroupName: 'platform'
    })

    expect(html).toContain('Import separately')
    expect(html).toContain('Import as project group')
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('shows a stop action and disables import while nested scan is still running', () => {
    const html = renderRepoStep({
      nestedScan: {
        selectedPath: '/workspace/platform',
        selectedPathKind: 'non_git_folder',
        repos: [{ path: '/workspace/platform/apps/web', displayName: 'web', depth: 2 }],
        truncated: false,
        timedOut: false,
        stopped: false,
        durationMs: 4,
        maxDepth: 3,
        maxRepos: 100,
        timeoutMs: null
      },
      nestedScanInProgress: true,
      nestedSelectedPaths: new Set(['/workspace/platform/apps/web']),
      nestedGroupName: 'platform'
    })

    expect(html).toContain('Scanning... Found 1 git repository in this folder.')
    expect(html).toContain('aria-label="Stop scan"')
    expect(html).toContain('Showing partial scan results.')
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

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
    expect(html).toContain('Browse for a folder')
    expect(html).toContain('Clone a repo')
  })

  it('presents the local-folder card itself as the browse action', () => {
    const html = renderRepoStep()

    expect(html).toContain('border-border bg-muted/30')
    expect(html).toContain('focus:border-foreground/70')
    expect(html).toContain('focus:ring-2 focus:ring-inset focus:ring-foreground/25')
    expect(html).toContain('autofocus=""')
    expect(html).toContain('Browse for a folder')
    expect(html).toContain('group-hover:translate-x-0.5')
    expect(html).toContain('w-fit max-w-[calc(100%-3.75rem)]')
    expect(html).toContain('Want to import many repos at once? Select the parent folder.')
  })

  it('disables the nested import action when no repositories are selected', () => {
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
      }
    })

    expect(html).toContain('Import repositories')
    expect(html).toContain('Scanned folder: platform - /workspace/platform')
    expect(html).not.toContain('Group name')
    expect(html).not.toContain('Import separately')
    expect(html).not.toContain('Import as project group')
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(1)
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
      nestedSelectedPaths: new Set(['/workspace/platform/apps/web'])
    })

    expect(html).toContain('Scanning... Found 1 repository in this folder.')
    expect(html).toContain('aria-label="Stop scan"')
    expect(html).toContain('Showing partial scan results.')
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('shows a flat nested repository checklist with collision labels', () => {
    const html = renderRepoStep({
      nestedScan: {
        selectedPath: '/workspace/platform',
        selectedPathKind: 'non_git_folder',
        repos: [
          { path: '/workspace/platform/web', displayName: 'web', depth: 1 },
          { path: '/workspace/platform/payments/api', displayName: 'api', depth: 2 },
          { path: '/workspace/platform/billing/api', displayName: 'api', depth: 2 }
        ],
        truncated: false,
        timedOut: false,
        stopped: false,
        durationMs: 4,
        maxDepth: 3,
        maxRepos: 100,
        timeoutMs: null
      },
      nestedSelectedPaths: new Set(['/workspace/platform/web'])
    })

    expect(html).toContain('Found 3 repositories in this folder.')
    expect(html).toContain('web')
    expect(html).toContain('payments/api')
    expect(html).toContain('billing/api')
    expect(html).not.toContain('Project group')
  })
})

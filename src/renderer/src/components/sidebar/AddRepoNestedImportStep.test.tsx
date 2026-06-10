import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AddRepoNestedImportStep } from './AddRepoNestedImportStep'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog } from '@/components/ui/dialog'
import type { NestedRepoScanResult } from '../../../../shared/types'

const scan: NestedRepoScanResult = {
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
}

describe('AddRepoNestedImportStep', () => {
  it('allows grouped import with a blank group name and flat collision labels', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Dialog open>
          <AddRepoNestedImportStep
            scan={scan}
            groupName=""
            selectedPaths={new Set(scan.repos.map((repo) => repo.path))}
            isFirstRepoImport={false}
            isAdding={false}
            scanInProgress={false}
            onGroupNameChange={vi.fn()}
            onSelectedPathsChange={vi.fn()}
            onImport={vi.fn()}
            onStopScan={vi.fn()}
          />
        </Dialog>
      </TooltipProvider>
    )

    expect(html).toContain('Import repositories from folder')
    expect(html).toContain('Found 3 repositories in')
    expect(html).toContain('/workspace/platform')
    expect(html).toContain('aria-label="Group name"')
    expect(html).toContain('aria-label="What is a group name?"')
    expect(html).toContain('Import separately')
    expect(html).toContain('Import as group')
    expect(html).toContain('payments/api')
    expect(html).toContain('billing/api')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('>Back</button>')
    expect(html).not.toContain('Project group')
  })

  it('shows a single primary import action for a first repo import', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Dialog open>
          <AddRepoNestedImportStep
            scan={scan}
            groupName=""
            selectedPaths={new Set(scan.repos.map((repo) => repo.path))}
            isFirstRepoImport={true}
            isAdding={false}
            scanInProgress={false}
            onGroupNameChange={vi.fn()}
            onSelectedPathsChange={vi.fn()}
            onImport={vi.fn()}
            onStopScan={vi.fn()}
          />
        </Dialog>
      </TooltipProvider>
    )

    expect(html).toContain('Found 3 repositories in')
    expect(html).toContain('data-variant="default"')
    expect(html).toContain('>Import</button>')
    expect(html).not.toContain('aria-label="Group name"')
    expect(html).not.toContain('What is a group name?')
    expect(html).not.toContain('Import as group')
    expect(html).not.toContain('Import separately')
    expect(html).not.toContain('>Back</button>')
  })
})

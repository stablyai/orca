import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RepoStep } from './RepoStep'

function renderRepoStep(overrides: Partial<ComponentProps<typeof RepoStep>> = {}): string {
  return renderToStaticMarkup(
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
  )
}

describe('RepoStep', () => {
  it('renders the add project options without existing-project chrome', () => {
    const html = renderRepoStep()

    expect(html).not.toContain('Project already added')
    expect(html).toContain('Open a folder')
    expect(html).toContain('Clone a repo')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NestedRepoChecklist } from './NestedRepoChecklist'
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

describe('NestedRepoChecklist', () => {
  it('renders a flat checklist with stable collision labels', () => {
    const html = renderToStaticMarkup(
      <NestedRepoChecklist
        scan={scan}
        selectedPaths={new Set(scan.repos.map((repo) => repo.path))}
        onSelectedPathsChange={vi.fn()}
      />
    )

    expect(html).toContain('Deselect all')
    expect(html).toContain('3 of 3 selected')
    expect(html).toContain('web')
    expect(html).toContain('payments/api')
    expect(html).toContain('billing/api')
    expect(html).not.toContain('Project group')
    expect(html).not.toContain('/workspace/platform/payments/api')
  })
})

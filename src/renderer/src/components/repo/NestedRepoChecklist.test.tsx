import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NestedRepoChecklist } from './NestedRepoChecklist'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'

const scan: NestedRepoScanResult = {
  selectedPath: '/workspace/platform',
  selectedPathKind: 'git_repo',
  repos: [
    { path: '/workspace/platform', displayName: 'platform', depth: 0 },
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
    expect(html).toContain('4 of 4 selected')
    expect(html).toContain('web')
    expect(html).toContain('payments/api')
    expect(html).toContain('billing/api')
    expect(html).not.toContain('Project group')
  })

  it('shows each repository location relative to the scanned folder', () => {
    const html = renderToStaticMarkup(
      <NestedRepoChecklist
        scan={scan}
        selectedPaths={new Set(scan.repos.map((repo) => repo.path))}
        onSelectedPathsChange={vi.fn()}
      />
    )

    expect(html).toContain('./web')
    expect(html).toContain('./payments/api')
    expect(html).toContain('./billing/api')
    // The scanned folder is its own root, so it carries the absolute path.
    expect(html).toContain('>/workspace/platform<')
    // Hovering any row still reveals the full path.
    expect(html).toContain('title="/workspace/platform/billing/api"')
  })

  it('badges submodule candidates only', () => {
    const html = renderToStaticMarkup(
      <NestedRepoChecklist
        scan={{
          ...scan,
          repos: [
            { path: '/workspace/platform/web', displayName: 'web', depth: 1 },
            {
              path: '/workspace/platform/web/design',
              displayName: 'design',
              depth: 2,
              isSubmodule: true
            }
          ]
        }}
        selectedPaths={new Set()}
        onSelectedPathsChange={vi.fn()}
      />
    )

    // Why anchored and not merely counted: inverting the condition badges the
    // plain clone and leaves the real submodule bare, and the count stays 1.
    expect(html.match(/Submodule/g)).toHaveLength(1)
    const designIndex = html.indexOf('./web/design')
    const badgeIndex = html.indexOf('Submodule')
    const webIndex = html.indexOf('>web<')
    expect(designIndex).toBeGreaterThan(-1)
    expect(badgeIndex).toBeGreaterThan(webIndex)
    expect(Math.abs(badgeIndex - designIndex)).toBeLessThan(400)
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCombinedDiffFileTreeCollapsedByDefault } from './combined-diff-file-tree-default'

const COMPONENTS_ROOT = join(__dirname, '..')

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENTS_ROOT, relativePath), 'utf8')
}

describe('isCombinedDiffFileTreeCollapsedByDefault', () => {
  it('opens the tree only for an explicit shown default', () => {
    expect(isCombinedDiffFileTreeCollapsedByDefault(true)).toBe(false)
    expect(isCombinedDiffFileTreeCollapsedByDefault(false)).toBe(true)
    expect(isCombinedDiffFileTreeCollapsedByDefault(undefined)).toBe(true)
  })
})

describe('diff surfaces seed their file tree from the saved default', () => {
  // Why source-level: both PR viewers previously hardcoded useState(false), which made
  // Settings > "Default Diff File Tree" a lie on the pull request surfaces.
  it.each(['PullRequestPage.tsx', 'GitHubItemDialog.tsx'])('%s', (file) => {
    const source = componentSource(file)

    expect(source).toContain(
      'isCombinedDiffFileTreeCollapsedByDefault(settings?.combinedDiffFileTreeVisibleByDefault)'
    )
    expect(source).not.toContain(
      'const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false)'
    )
    expect(source).toContain("recordFeatureInteraction('diff-file-tree')")
  })
})

import { describe, expect, it } from 'vitest'

import type { GitStatusEntry } from '../../git/status/git-status-types'
import { buildSourceControlTree, collectSourceControlTreeFileEntries } from './source-control-tree'

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    status: 'modified',
    area: 'unstaged',
    ...partial
  }
}

describe('buildSourceControlTree', () => {
  it('collects all descendant file entries for directory actions', () => {
    const tree = buildSourceControlTree('unstaged', [
      entry({ path: 'src/app.ts' }),
      entry({ path: 'src/components/Button.tsx' }),
      entry({ path: 'docs/readme.md' })
    ])

    const src = tree.find((node) => node.type === 'directory' && node.path === 'src')

    expect(src ? collectSourceControlTreeFileEntries(src).map((item) => item.path) : []).toEqual([
      'src/components/Button.tsx',
      'src/app.ts'
    ])
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readWorktreeListSource(): string {
  return readFileSync(fileURLToPath(new URL('./WorktreeList.tsx', import.meta.url)), 'utf8')
}

describe('Project Group header drag DOM source', () => {
  it('renders concrete Project Group header drag attributes separately from repo headers', () => {
    const source = readWorktreeListSource()

    expect(source).toContain('data-project-group-header-id={projectGroupIdForHeader}')
    expect(source).toContain('data-project-group-header-index={projectGroupHeaderIndex}')
    expect(source).toContain('data-project-group-header-bucket={projectGroupHeaderBucketKey}')
    expect(source).toContain('data-project-group-header-drag-handle=')
  })

  it('commits Project Group manual sorting through updateProjectGroup tabOrder', () => {
    const source = readWorktreeListSource()

    expect(source).toContain('const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)')
    expect(source).toContain('void updateProjectGroup(groupId, { tabOrder })')
  })
})

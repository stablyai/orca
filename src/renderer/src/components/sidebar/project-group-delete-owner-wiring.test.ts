import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readWorktreeListSource(): string {
  return readFileSync(fileURLToPath(new URL('./WorktreeList.tsx', import.meta.url)), 'utf8')
}

describe('Project Group deletion owner wiring', () => {
  it('carries the clicked row owner through the dialog and delete request', () => {
    const source = readWorktreeListSource()

    expect(source).toContain('handleDeleteProjectGroup(row.projectGroup, row.label)')
    expect(source).toContain('getProjectGroupExecutionHostIdForRows(projectGroup, defaultHostId)')
    expect(source).toContain('hostId,')
    expect(source).toContain('hostId: projectGroupDeleteDialog.hostId')
  })

  it('scopes confirmation projects and names to the clicked host', () => {
    const source = readWorktreeListSource()
    const targetStart = source.indexOf('const projectGroupDeleteTargets = useMemo')
    const targetEnd = source.indexOf('const projectGroupDeleteProjectCount', targetStart)
    const targetBlock = source.slice(targetStart, targetEnd)

    expect(targetStart).toBeGreaterThan(-1)
    expect(targetEnd).toBeGreaterThan(targetStart)
    expect(targetBlock).toContain('getProjectGroupDeletePreview({')
    expect(targetBlock).toContain('...projectGroupDeleteDialog,')
    expect(targetBlock).toContain('defaultHostId,')
    expect(targetBlock).toContain('projectGroups,')
    expect(targetBlock).toContain('repos')
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string): string {
  return readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/dashboard-popout', file),
    'utf8'
  )
}

describe('Agent Map workspace menu performance boundary', () => {
  it('loads store-backed workspace actions only after a ring context request', () => {
    const loader = source('AgentMapWorkspaceContextMenuLoader.tsx')
    const menu = source('AgentMapWorkspaceContextMenu.tsx')

    expect(loader).toMatch(/import\('\.\/AgentMapWorkspaceContextMenu'\)/)
    expect(loader).not.toMatch(
      /import\s+\{\s*AgentMapWorkspaceContextMenu\s*\}\s+from\s+['"]\.\/AgentMapWorkspaceContextMenu['"]/
    )
    expect(menu).toMatch(/import\('@\/components\/sidebar\/WorktreeContextMenu'\)/)
    expect(menu).not.toMatch(
      /import\s+WorktreeContextMenu\s+from\s+['"]@\/components\/sidebar\/WorktreeContextMenu['"]/
    )
  })

  it('loads store-backed project actions only after a project context request', () => {
    const loader = source('AgentMapProjectContextMenuLoader.tsx')

    expect(loader).toMatch(/import\('\.\/AgentMapProjectContextMenu'\)/)
    expect(loader).not.toMatch(
      /import\s+\{\s*AgentMapProjectContextMenu\s*\}\s+from\s+['"]\.\/AgentMapProjectContextMenu['"]/
    )
  })
})

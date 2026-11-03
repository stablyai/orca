import { describe, expect, it } from 'vitest'
import { classifyAgentWritePath } from './linked-repo-path-match'

const PROJ1 = { id: 'r1::/work/proj1', path: '/work/proj1' }
const PROJ2 = { id: 'r2::/work/proj2', path: '/work/proj2' }
const NESTED = { id: 'r3::/work/proj2/vendor/lib', path: '/work/proj2/vendor/lib' }

describe('classifyAgentWritePath', () => {
  it('links an edit in a registered sibling repo', () => {
    expect(classifyAgentWritePath('/work/proj2/src/a.ts', [PROJ1, PROJ2], PROJ1)).toEqual({
      kind: 'registered',
      worktree: PROJ2
    })
  })

  it('treats relative paths as the agent workspace', () => {
    expect(classifyAgentWritePath('src/a.ts', [PROJ1, PROJ2], PROJ1)).toEqual({ kind: 'own' })
  })

  it('reports a folder outside every project as unregistered', () => {
    expect(classifyAgentWritePath('/work/proj10/a.ts', [PROJ1], PROJ1)).toEqual({
      kind: 'unregistered',
      filePath: '/work/proj10/a.ts'
    })
  })

  it('prefers the deepest containing repo', () => {
    expect(classifyAgentWritePath('/work/proj2/vendor/lib/x.c', [PROJ2, NESTED], PROJ1)).toEqual({
      kind: 'registered',
      worktree: NESTED
    })
  })

  it('keeps the source worktree when it is nested inside a candidate', () => {
    expect(classifyAgentWritePath('/work/proj2/vendor/lib/x.c', [PROJ2, NESTED], NESTED)).toEqual({
      kind: 'own'
    })
  })

  it('keeps a folder workspace source nested inside a registered repo', () => {
    const folder = { id: 'f::/work/proj2/notes', path: '/work/proj2/notes' }
    expect(classifyAgentWritePath('/work/proj2/notes/today.md', [PROJ2], folder)).toEqual({
      kind: 'own'
    })
  })

  it('maps Git Bash /c/ paths onto a Windows workspace', () => {
    const win = { id: 'w2', path: 'C:\\Work\\Proj2' }
    const source = { id: 'w1', path: 'C:\\Work\\Proj1' }
    expect(classifyAgentWritePath('/c/Work/Proj2/a.ts', [win], source)).toEqual({
      kind: 'registered',
      worktree: win
    })
  })

  it('matches Windows paths regardless of separator and case', () => {
    const win = { id: 'w::C:\\Work\\Proj2', path: 'C:\\Work\\Proj2' }
    const source = { id: 'w1', path: 'C:\\Work\\Proj1' }
    expect(classifyAgentWritePath('c:/work/proj2/README.md', [win], source)).toEqual({
      kind: 'registered',
      worktree: win
    })
  })
})

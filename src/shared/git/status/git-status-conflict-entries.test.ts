/** Porcelain v2 mW already proves asymmetric conflict-path presence; avoid reintroducing one 9P/network fs.access trip per row. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const { accessMock } = vi.hoisted(() => ({ accessMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  access: accessMock
}))

import { parseUnmergedEntry } from './git-status-conflict-entries'

const WORKTREE = '/repo'

/** `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — `mW` is the working-tree mode. */
function unmergedLine(xy: string, modeWorktree: string, filePath: string): string {
  return `u ${xy} N... 100644 100644 100644 ${modeWorktree} aaa bbb ccc ${filePath}`
}

const ASYMMETRIC_KINDS = ['AU', 'UA', 'DU', 'UD'] as const

describe('parseUnmergedEntry', () => {
  beforeEach(() => {
    accessMock.mockReset()
    accessMock.mockRejectedValue(new Error('fs.access must not be reached for well-formed records'))
  })

  it('reads the working-tree mode instead of probing the filesystem', async () => {
    for (const xy of ASYMMETRIC_KINDS) {
      const absent = await parseUnmergedEntry(WORKTREE, unmergedLine(xy, '000000', 'gone.ts'))
      const present = await parseUnmergedEntry(WORKTREE, unmergedLine(xy, '100644', 'here.ts'))

      expect(absent?.status, xy).toBe('deleted')
      expect(present?.status, xy).toBe('modified')
    }

    expect(accessMock).not.toHaveBeenCalled()
  })
})

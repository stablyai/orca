import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findFilePathLinkAtBufferPosition,
  openFilePathLinkAtBufferPosition
} from './terminal-file-link-hit-testing'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { makeBuffer, makeBufferLine } from './terminal-link-provider-buffer-fixtures'

vi.mock('./terminal-file-open-routing', () => ({
  openDetectedFilePath: vi.fn()
}))

const deps = {
  startupCwd: '/repo',
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  runtimeEnvironmentId: null
}

describe('terminal file link hit testing', () => {
  beforeEach(() => {
    vi.mocked(openDetectedFilePath).mockClear()
  })

  it('finds the resolved file and source location under the buffer position', () => {
    const match = findFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('src/app.ts:12:4')]),
      { x: 5, y: 1 },
      80,
      deps
    )

    expect(match).toEqual({ absolutePath: '/repo/src/app.ts', line: 12, column: 4 })
  })

  it.each(['plain terminal output', ''])('returns null away from a file link: %j', (text) => {
    expect(
      findFilePathLinkAtBufferPosition(makeBuffer([makeBufferLine(text)]), { x: 1, y: 1 }, 80, deps)
    ).toBeNull()
  })

  it('can retain a detected path known to be missing for reveal error reporting', () => {
    expect(
      findFilePathLinkAtBufferPosition(
        makeBuffer([makeBufferLine('missing.ts')]),
        { x: 4, y: 1 },
        80,
        {
          ...deps,
          includeCachedMissing: true,
          pathExistsCache: new Map([['active\0/repo/missing.ts', false]])
        }
      )
    ).toEqual({ absolutePath: '/repo/missing.ts', line: null, column: null })
  })

  it('opens the same preferred match returned by the finder', () => {
    const pathExistsCache = new Map([
      ['active\0/repo/My Folder', true],
      ['active\0/repo/My', true]
    ])
    const buffer = makeBuffer([makeBufferLine('/repo/My Folder/file.ts')])
    const position = { x: 10, y: 1 }
    const finderMatch = findFilePathLinkAtBufferPosition(buffer, position, 80, {
      ...deps,
      pathExistsCache
    })

    expect(
      openFilePathLinkAtBufferPosition(buffer, position, 80, {
        ...deps,
        pathExistsCache
      })
    ).toBe(true)
    expect(openDetectedFilePath).toHaveBeenCalledWith(
      finderMatch?.absolutePath,
      finderMatch?.line,
      finderMatch?.column,
      expect.objectContaining(deps)
    )
  })
})

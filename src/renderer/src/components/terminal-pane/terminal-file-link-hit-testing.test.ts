import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureFilePathLinkAtBufferPosition,
  openFilePathLinkAtBufferPosition
} from './terminal-file-link-hit-testing'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { fileLinkTargetExists } from './terminal-file-link-target'
import {
  makeBuffer,
  makeBufferLine,
  makeExistsCache
} from './terminal-link-provider-buffer-fixtures'

vi.mock('./terminal-file-open-routing', () => ({
  openDetectedFilePath: vi.fn()
}))
vi.mock('./terminal-file-link-target', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fileLinkTargetExists: vi.fn()
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
    vi.mocked(fileLinkTargetExists).mockReset().mockResolvedValue(false)
  })

  it('finds the resolved file and source location under the buffer position', async () => {
    const match = await captureFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('src/app.ts:12:4')]),
      { x: 5, y: 1 },
      80,
      deps
    )?.()

    expect(match).toEqual({ absolutePath: '/repo/src/app.ts', line: 12, column: 4 })
  })

  it.each(['plain terminal output', ''])('returns null away from a file link: %j', (text) => {
    expect(
      captureFilePathLinkAtBufferPosition(
        makeBuffer([makeBufferLine(text)]),
        { x: 1, y: 1 },
        80,
        deps
      )
    ).toBeNull()
  })

  it('can retain a detected path known to be missing for reveal error reporting', async () => {
    await expect(
      captureFilePathLinkAtBufferPosition(
        makeBuffer([makeBufferLine('src/missing.ts')]),
        { x: 6, y: 1 },
        80,
        {
          ...deps,
          includeCachedMissing: true,
          pathExistsCache: makeExistsCache([['active\0/repo/src/missing.ts', false]])
        }
      )?.()
    ).resolves.toEqual({ absolutePath: '/repo/src/missing.ts', line: null, column: null })
  })

  it('leaves a bare dotted word known to be missing to the cwd reveal', () => {
    expect(
      captureFilePathLinkAtBufferPosition(
        makeBuffer([makeBufferLine('console.log')]),
        { x: 4, y: 1 },
        80,
        {
          ...deps,
          includeCachedMissing: true,
          pathExistsCache: makeExistsCache([['active\0/repo/console.log', false]])
        }
      )
    ).toBeNull()
  })

  it('names the visible path when every hard-wrap reading is known missing', async () => {
    const fragment = 'modules/twowayaudio/ExpoTwoWayAudioLifeCycleListener.kt'
    const resolve = captureFilePathLinkAtBufferPosition(
      makeBuffer([
        makeBufferLine('/repo/packages/expo-two-way-audio/android/src/main/java/expo/'),
        makeBufferLine(fragment)
      ]),
      { x: 5, y: 2 },
      62,
      {
        ...deps,
        includeCachedMissing: true,
        pathExistsCache: makeExistsCache([
          [`active\0/repo/${fragment}`, false],
          [
            `active\0/repo/packages/expo-two-way-audio/android/src/main/java/expo/${fragment}`,
            false
          ]
        ])
      }
    )

    await expect(resolve?.()).resolves.toEqual({
      absolutePath: `/repo/${fragment}`,
      line: null,
      column: null
    })
    expect(fileLinkTargetExists).not.toHaveBeenCalled()
  })

  it('opens the same preferred match returned by the finder', async () => {
    const pathExistsCache = makeExistsCache([['active\0/repo/My Folder/file.ts', true]])
    const buffer = makeBuffer([makeBufferLine('/repo/My Folder/file.ts')])
    const position = { x: 10, y: 1 }
    const finderMatch = await captureFilePathLinkAtBufferPosition(buffer, position, 80, {
      ...deps,
      pathExistsCache
    })?.()

    expect(finderMatch?.absolutePath).toBe('/repo/My Folder/file.ts')
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

  it('probes competing hard-wrap guesses before naming the reveal target', async () => {
    const rows = [
      makeBufferLine('/repo/packages/expo-two-way-audio/android/src/main/java/expo/'),
      makeBufferLine('modules/twowayaudio/ExpoTwoWayAudioLifeCycleListener.kt')
    ]
    const fullPath =
      '/repo/packages/expo-two-way-audio/android/src/main/java/expo/modules/twowayaudio/ExpoTwoWayAudioLifeCycleListener.kt'
    vi.mocked(fileLinkTargetExists).mockImplementation(
      async (target) => target.absolutePath === fullPath
    )

    const resolve = captureFilePathLinkAtBufferPosition(makeBuffer(rows), { x: 5, y: 2 }, 62, {
      ...deps,
      includeCachedMissing: true,
      pathExistsCache: makeExistsCache()
    })

    expect(fileLinkTargetExists).not.toHaveBeenCalled()
    await expect(resolve?.()).resolves.toEqual({ absolutePath: fullPath, line: null, column: null })
    expect(fileLinkTargetExists).toHaveBeenCalled()
  })
})

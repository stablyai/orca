import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { chmodSyncMock, existsSyncMock, paths, statSyncMock, state } = vi.hoisted(() => ({
  chmodSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  paths: {
    dir: '/secure',
    file: '/secure/secret.json'
  },
  statSyncMock: vi.fn(),
  state: {
    dirMode: 0o755,
    fileMode: 0o600
  }
}))

vi.mock('fs', () => ({
  chmodSync: chmodSyncMock,
  existsSync: existsSyncMock,
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: statSyncMock,
  writeFileSync: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn()
}))

import {
  __resetSecureFileHardenedPathsForTests,
  __resetSecureFileWindowsUserSidForTests,
  hardenExistingSecureFile
} from './secure-file'

describe('secure-file coarse-ctime mode drift', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    state.dirMode = 0o755
    state.fileMode = 0o600
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockImplementation((targetPath: string) => {
      const path = String(targetPath)
      if (path === paths.dir) {
        return fakeStats(true, state.dirMode)
      }
      if (path === paths.file) {
        return fakeStats(false, state.fileMode)
      }
      throw new Error(`unexpected stat path ${path}`)
    })
    chmodSyncMock.mockImplementation((targetPath: string, mode: number) => {
      const path = String(targetPath)
      if (path === paths.dir) {
        state.dirMode = mode & 0o777
      } else if (path === paths.file) {
        state.fileMode = mode & 0o777
      }
    })
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
  })

  afterEach(() => {
    chmodSyncMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('re-hardens a directory when only POSIX mode changes under stable timestamps', () => {
    hardenExistingSecureFile(paths.file)
    expect(chmodSyncMock.mock.calls).toEqual([
      [paths.dir, 0o700],
      [paths.file, 0o600]
    ])

    chmodSyncMock.mockClear()
    // Coarse-ctime filesystems can report identical timestamps after chmod; only mode changes.
    state.dirMode = 0o755

    hardenExistingSecureFile(paths.file)

    expect(chmodSyncMock.mock.calls).toEqual([[paths.dir, 0o700]])
  })

  it('re-hardens a file when only POSIX mode changes under stable timestamps', () => {
    hardenExistingSecureFile(paths.file)
    expect(chmodSyncMock.mock.calls).toEqual([
      [paths.dir, 0o700],
      [paths.file, 0o600]
    ])

    chmodSyncMock.mockClear()
    // Coarse-ctime filesystems can report identical timestamps after chmod; only mode changes.
    state.fileMode = 0o644

    hardenExistingSecureFile(paths.file)

    expect(chmodSyncMock.mock.calls).toEqual([[paths.file, 0o600]])
  })
})

function fakeStats(isDirectory: boolean, mode: number) {
  return {
    birthtimeMs: 10,
    ctimeMs: 20,
    dev: 30,
    ino: isDirectory ? 40 : 41,
    isDirectory: () => isDirectory,
    mode,
    mtimeMs: 50,
    size: isDirectory ? 0 : 2
  }
}

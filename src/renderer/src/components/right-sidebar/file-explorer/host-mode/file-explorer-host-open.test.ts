import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openFileMock } = vi.hoisted(() => ({ openFileMock: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ openFile: openFileMock }) } }))

import { openHostFile } from './file-explorer-host-open'

beforeEach(() => {
  openFileMock.mockReset()
})

describe('openHostFile', () => {
  it('opens files outside the workspace read-only and marks them session-only', () => {
    openHostFile({
      plan: { kind: 'external', filePath: '/home/allen/.bashrc' },
      source: { kind: 'local' },
      worktreeId: 'wt-1'
    })

    const [file, options] = openFileMock.mock.calls[0] ?? []
    expect(file).toEqual(
      expect.objectContaining({
        filePath: '/home/allen/.bashrc',
        relativePath: '/home/allen/.bashrc',
        worktreeId: 'wt-1',
        mode: 'edit',
        readOnly: true,
        hostBrowse: true,
        runtimeEnvironmentId: null
      })
    )
    expect(file).not.toHaveProperty('liveTail')
    expect(file).not.toHaveProperty('terminalArtifactGrantId')
    expect(options).toEqual(expect.objectContaining({ suppressActiveRuntimeFallback: true }))
  })

  it("reads runtime-host files through the host's runtime and its single-file grant", () => {
    const runtime = { kind: 'runtime', environmentId: 'env-1', executionHostId: 'ssh:box' } as const
    openHostFile({
      plan: { kind: 'external', filePath: '/srv/real/notes.md', grantId: 'grant-1' },
      source: runtime,
      worktreeId: 'wt-1'
    })
    openHostFile({
      plan: { kind: 'workspace', filePath: '/Data2/allen/project/a.ts', relativePath: 'a.ts' },
      source: runtime,
      worktreeId: 'wt-1'
    })

    expect(openFileMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        readOnly: true,
        hostBrowse: true,
        runtimeEnvironmentId: 'env-1',
        terminalArtifactGrantId: 'grant-1'
      })
    )
    expect(openFileMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ relativePath: 'a.ts', runtimeEnvironmentId: 'env-1' })
    )
    expect(openFileMock.mock.calls[1]?.[0]).not.toHaveProperty('terminalArtifactGrantId')
    for (const [, options] of openFileMock.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ suppressActiveRuntimeFallback: false }))
    }
  })

  it('opens workspace files through the normal writable Explorer path', () => {
    openHostFile({
      plan: { kind: 'workspace', filePath: '/home/allen/codes/src/a.ts', relativePath: 'src/a.ts' },
      source: { kind: 'local' },
      worktreeId: 'wt-1'
    })

    const [file] = openFileMock.mock.calls[0] ?? []
    expect(file).toEqual(expect.objectContaining({ relativePath: 'src/a.ts' }))
    expect(file).not.toHaveProperty('readOnly')
    expect(file).not.toHaveProperty('hostBrowse')
  })
})

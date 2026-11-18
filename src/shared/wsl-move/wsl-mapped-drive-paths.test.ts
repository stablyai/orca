import { describe, expect, it } from 'vitest'
import {
  sameWslMappedDrives,
  toWslDistroUncPath,
  wslMappedDriveComparisonKeyToLinux,
  wslMappedDriveFileUrlToLinux,
  wslMoveSourcePathToLinux
} from './wsl-mapped-drive-paths'
import { parseWslMoveRequest } from './wsl-move-request'
import { wslMoveRendererRewriteScope } from './wsl-move-renderer-rewrite-scope'

const W = { letter: 'W', share: '\\\\wsl.localhost\\Ubuntu' }
const H = { letter: 'H', share: '\\\\wsl$\\Ubuntu\\home' }

describe('mapped-drive paths', () => {
  it('spells a mapped path as the share and leaves other drives alone', () => {
    expect(toWslDistroUncPath('W:\\home\\me\\App', [W])).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\App'
    )
    expect(toWslDistroUncPath('w:/home/me/App/', [W])).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\App'
    )
    expect(toWslDistroUncPath('X:\\home\\me\\App', [W])).toBe('X:\\home\\me\\App')
    expect(wslMoveSourcePathToLinux('H:\\me\\App', 'ubuntu', [H])).toBe('/home/me/App')
    expect(wslMoveSourcePathToLinux('W:\\..\\x', 'Ubuntu', [W])).toBeNull()
  })

  it('maps a file URL on a mapped drive, keeping its encoding', () => {
    expect(wslMappedDriveFileUrlToLinux('file:///W:/home/me/a%20b.ts', 'Ubuntu', [W])).toBe(
      'file:///home/me/a%20b.ts'
    )
    expect(wslMappedDriveFileUrlToLinux('file:///H:/me/x#L2', 'Ubuntu', [H])).toBe(
      'file:///home/me/x#L2'
    )
    expect(wslMappedDriveFileUrlToLinux('file:///X:/home/me', 'Ubuntu', [W])).toBeNull()
  })

  it('refuses a file URL whose `..` climbs out of the share, as the path form does', () => {
    expect(wslMappedDriveFileUrlToLinux('file:///H:/a/../../etc/passwd', 'Ubuntu', [H])).toBeNull()
    expect(wslMappedDriveFileUrlToLinux('file:///H:/a/%2E%2E/%2E%2E/etc', 'Ubuntu', [H])).toBeNull()
    expect(wslMappedDriveFileUrlToLinux('file:///H:/me/../me/x', 'Ubuntu', [H])).toBe(
      'file:///home/me/../me/x'
    )
  })

  it('restores a folded key case from the innermost moved root', () => {
    const roots = ['/home/me/App', '/home/me/App/Trees/Feature']
    expect(wslMappedDriveComparisonKeyToLinux('w:/home/me/app/src', 'Ubuntu', [W], roots)).toBe(
      '/home/me/App/src'
    )
    expect(
      wslMappedDriveComparisonKeyToLinux('w:/home/me/app/trees/feature/x', 'Ubuntu', [W], roots)
    ).toBe('/home/me/App/Trees/Feature/x')
    // A saved path keeps its own case; only folded keys are re-keyed.
    expect(wslMappedDriveComparisonKeyToLinux('W:\\home\\me\\App', 'Ubuntu', [W], roots)).toBeNull()
    expect(wslMappedDriveComparisonKeyToLinux('w:/srv/other', 'Ubuntu', [W], roots)).toBeNull()
  })

  it('compares mappings by letter and share, not order or spelling', () => {
    expect(
      sameWslMappedDrives([W, H], [{ letter: 'H', share: '\\\\wsl.localhost\\ubuntu\\home' }, W])
    ).toBe(true)
    expect(sameWslMappedDrives([W], [{ letter: 'W', share: '\\\\wsl.localhost\\Debian' }])).toBe(
      false
    )
    expect(sameWslMappedDrives([W], [])).toBe(false)
  })

  it('accepts the mapping a start sends back, and refuses one that names no distro', () => {
    expect(parseWslMoveRequest({ distro: 'Ubuntu', mappedDrives: [W] })?.mappedDrives).toEqual([W])
    expect(
      parseWslMoveRequest({ distro: 'Ubuntu', mappedDrives: [{ letter: 'W', share: 'C:\\x' }] })
    ).toBeNull()
  })
})

describe('wslMoveRendererRewriteScope with mapped drives', () => {
  const move = {
    distro: 'Ubuntu',
    scopeRepoIds: ['repo-1'],
    scopeFolderWorkspaceIds: [],
    destinationHostId: 'runtime:wsl:Ubuntu' as const,
    destinationEnvironmentId: 'wsl:Ubuntu',
    scopeRootPaths: ['/home/me/App'],
    mappedDrives: [W]
  }

  it('maps W: paths, folded w:/ keys and worktree ids to the host with exact case', () => {
    const scope = wslMoveRendererRewriteScope(move)
    expect(scope.hostPath('W:\\home\\me\\App\\src\\Main.ts')).toBe('/home/me/App/src/Main.ts')
    expect(scope.hostPath('w:/home/me/app')).toBe('/home/me/App')
    expect(scope.hostWorktreeId('repo-1::W:\\home\\me\\App')).toBe('repo-1::/home/me/App')
    expect(scope.hostPath('X:\\home\\me\\App')).toBeNull()
  })

  it('leaves W: paths alone for a move that mapped no drive', () => {
    const scope = wslMoveRendererRewriteScope({ ...move, mappedDrives: undefined })
    expect(scope.hostPath('W:\\home\\me\\App')).toBeNull()
  })
})

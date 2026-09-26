import { describe, expect, it, vi } from 'vitest'
import {
  createGitObjectQuarantine,
  GIT_OBJECT_QUARANTINE_DIR_PREFIX,
  type GitObjectQuarantineHost,
  type GitObjectsDirectory
} from './git-object-quarantine'

function fakeHost(
  objects: GitObjectsDirectory | undefined,
  overrides: Partial<GitObjectQuarantineHost> = {}
) {
  return {
    resolveObjectsDirectory: vi.fn(async () => objects),
    makeTempDirectory: vi.fn(async (prefix: string) => `${prefix}AbC123`),
    removeDirectory: vi.fn(async () => {}),
    ...overrides
  }
}

describe('createGitObjectQuarantine', () => {
  it('points Git at a scratch dir inside objects/ and removes it afterwards', async () => {
    const host = fakeHost({ hostPath: '/repo/.git/objects', gitPath: '/repo/.git/objects' })
    const command = vi.fn(async () => 'ok')

    await expect(createGitObjectQuarantine(host).run(command)).resolves.toBe('ok')

    const scratch = `/repo/.git/objects/${GIT_OBJECT_QUARANTINE_DIR_PREFIX}AbC123`
    expect(command).toHaveBeenCalledWith({
      GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/repo/.git/objects'
    })
    expect(host.removeDirectory).toHaveBeenCalledWith(scratch)
  })

  it('removes the scratch dir when the command fails', async () => {
    const host = fakeHost({ hostPath: '/r/objects', gitPath: '/r/objects' })
    const failure = new Error('merge-tree failed')

    await expect(
      createGitObjectQuarantine(host).run(async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(host.removeDirectory).toHaveBeenCalledTimes(1)
  })

  it('keeps the command result when the scratch dir cannot be removed', async () => {
    const host = fakeHost(
      { hostPath: '/r/objects', gitPath: '/r/objects' },
      {
        removeDirectory: vi.fn(async () => {
          throw new Error('EBUSY')
        })
      }
    )

    await expect(createGitObjectQuarantine(host).run(async () => 'tree')).resolves.toBe('tree')
  })

  it.each([
    ['the objects dir is unknown', fakeHost(undefined)],
    [
      'resolving the objects dir fails',
      fakeHost(undefined, {
        resolveObjectsDirectory: vi.fn(async () => {
          throw new Error('x')
        })
      })
    ],
    [
      'the scratch dir cannot be created',
      fakeHost(
        { hostPath: '/r/objects', gitPath: '/r/objects' },
        {
          makeTempDirectory: vi.fn(async () => {
            throw new Error('EACCES')
          })
        }
      )
    ]
  ])('runs the command unquarantined when %s', async (_label, host) => {
    const command = vi.fn(async () => 'ok')

    await expect(createGitObjectQuarantine(host).run(command)).resolves.toBe('ok')

    expect(command).toHaveBeenCalledWith(undefined)
    expect(host.removeDirectory).not.toHaveBeenCalled()
  })

  it('resolves the objects dir once and gives every run its own scratch dir', async () => {
    let next = 0
    const host = fakeHost(
      { hostPath: '/r/objects', gitPath: '/r/objects' },
      { makeTempDirectory: vi.fn(async (prefix: string) => `${prefix}${++next}`) }
    )
    const quarantine = createGitObjectQuarantine(host)
    const seen: (string | undefined)[] = []

    await quarantine.run(async (env) => seen.push(env?.GIT_OBJECT_DIRECTORY))
    await quarantine.run(async (env) => seen.push(env?.GIT_OBJECT_DIRECTORY))

    expect(host.resolveObjectsDirectory).toHaveBeenCalledTimes(1)
    expect(new Set(seen).size).toBe(2)
  })

  it('creates the scratch dir in host spelling but hands WSL Git its Linux spelling', async () => {
    const host = fakeHost({
      hostPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git\\objects',
      gitPath: '/home/me/repo/.git/objects'
    })
    const command = vi.fn(async () => 'ok')

    await createGitObjectQuarantine(host).run(command)

    expect(host.makeTempDirectory).toHaveBeenCalledWith(
      `\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git\\objects\\${GIT_OBJECT_QUARANTINE_DIR_PREFIX}`
    )
    expect(command).toHaveBeenCalledWith({
      GIT_OBJECT_DIRECTORY: `/home/me/repo/.git/objects/${GIT_OBJECT_QUARANTINE_DIR_PREFIX}AbC123`,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/home/me/repo/.git/objects'
    })
  })

  it.each([
    ['/plain/objects', '/plain/objects'],
    ['/odd:dir/objects', '"/odd:dir/objects"'],
    ['/quo"te\\dir/objects', '"/quo\\"te\\\\dir/objects"'],
    ['C:\\repo\\.git\\objects', 'C:\\repo\\.git\\objects']
  ])('spells alternates for %s so Git reads one entry', async (gitPath, expected) => {
    const host = fakeHost({ hostPath: gitPath, gitPath })
    const command = vi.fn(async () => 'ok')

    await createGitObjectQuarantine(host).run(command)

    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ GIT_ALTERNATE_OBJECT_DIRECTORIES: expected })
    )
  })
})

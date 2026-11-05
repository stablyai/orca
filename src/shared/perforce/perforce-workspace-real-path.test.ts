import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteChangelistWithFiles } from './perforce-changelists'
import {
  resolveDeletableInWorkspace,
  resolveReadableInWorkspace
} from './perforce-workspace-real-path'

const p4 = vi.hoisted(() => ({ added: [] as string[], calls: [] as string[][] }))
vi.mock('./p4-command', () => ({
  runP4: vi.fn(async (args: string[]) => {
    p4.calls.push(args)
    const stdout = args.includes('fstat')
      ? p4.added.map((file) => `... clientFile ${file}\n... action add\n`).join('\n')
      : ''
    return { code: 0, stdout, stderr: '' }
  }),
  runP4OrThrow: vi.fn()
}))

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

let base: string
let workspace: string
let outside: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'orca-p4-real-path-'))
  workspace = join(base, 'ws')
  outside = join(base, 'outside')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, 'notes.txt'), 'private')
  await writeFile(join(workspace, 'src', 'a.txt'), 'mine')
  // Why a junction: Windows creates one without elevation; other platforms make a plain link.
  await symlink(outside, join(workspace, 'link'), 'junction')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('workspace paths resolved through links', () => {
  it('allows files whose real folder is inside the workspace', async () => {
    expect(await resolveDeletableInWorkspace(workspace, 'src/a.txt')).toMatch(/a\.txt$/)
    expect(await resolveReadableInWorkspace(workspace, 'src/a.txt')).toMatch(/a\.txt$/)
  })

  it('refuses to delete or read through a linked folder that leaves the workspace', async () => {
    await expect(resolveDeletableInWorkspace(workspace, 'link/notes.txt')).rejects.toThrow(
      'escapes the workspace'
    )
    expect(await resolveReadableInWorkspace(workspace, 'link/notes.txt')).toBeNull()
  })

  it('treats a missing folder as nothing to delete', async () => {
    expect(await resolveDeletableInWorkspace(workspace, 'gone/a.txt')).toBeNull()
  })
})

describe('deleteChangelistWithFiles', () => {
  beforeEach(() => {
    p4.calls = []
  })

  it('stops before the revert when an added file sits behind a link that leaves the workspace', async () => {
    p4.added = [join(workspace, 'link', 'notes.txt')]
    await expect(deleteChangelistWithFiles(workspace, 7)).rejects.toThrow('escapes the workspace')
    expect(p4.calls.some((args) => args[0] === 'revert')).toBe(false)
    expect(await exists(join(outside, 'notes.txt'))).toBe(true)
  })

  it('deletes added files inside the workspace and leaves ones outside it on disk', async () => {
    p4.added = [join(workspace, 'src', 'a.txt'), join(outside, 'notes.txt')]
    await expect(deleteChangelistWithFiles(workspace, 7)).resolves.toMatchObject({ success: true })
    expect(await exists(join(workspace, 'src', 'a.txt'))).toBe(false)
    expect(await exists(join(outside, 'notes.txt'))).toBe(true)
  })
})

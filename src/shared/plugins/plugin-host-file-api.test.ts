import { describe, expect, it } from 'vitest'
import {
  PLUGIN_HOST_FILE_API_SPECS,
  PLUGIN_WORKSPACE_LIST_LIMIT,
  PLUGIN_WORKSPACE_REF_KEY_MAX_LENGTH,
  pluginWorkspaceRefSchema
} from './plugin-host-file-api'

const listSpec = PLUGIN_HOST_FILE_API_SPECS.find((spec) => spec.name === 'workspace.list')!
const fileSpecs = PLUGIN_HOST_FILE_API_SPECS.filter((spec) => spec.name.startsWith('files.'))

describe('pluginWorkspaceRefSchema', () => {
  it.each([
    ['identity:wt2%3Ahost%3Ainstance', { type: 'worktree', identity: 'wt2:host:instance' }],
    ['id:folder-1', { type: 'folder', id: 'folder-1' }]
  ])('parses path-free identity %s', (value, expected) => {
    expect(pluginWorkspaceRefSchema.parse(value)).toEqual(expected)
  })

  it.each([
    '',
    'identity:',
    'id:',
    'identity:id:folder-1',
    'id:identity:worktree-1',
    'main',
    'branch:main',
    'name:orca',
    'path:/repo',
    '/Users/private/repo',
    'C:\\private\\repo',
    '\\\\server\\share\\repo',
    'id:repo::/private/repo',
    'workspace:one',
    `identity:${'a'.repeat(PLUGIN_WORKSPACE_REF_KEY_MAX_LENGTH + 1)}`
  ])('rejects non-identity or path-bearing selector %s', (value) => {
    expect(pluginWorkspaceRefSchema.safeParse(value).success).toBe(false)
  })

  it.each([null, 1, {}, { type: 'folder', id: 'folder-1' }])(
    'rejects non-string selector %j',
    (value) => {
      expect(pluginWorkspaceRefSchema.safeParse(value).success).toBe(false)
    }
  )

  it('keeps workspace.list references reusable as file method inputs', () => {
    const listed = listSpec.result.parse({
      workspaces: [
        {
          ref: 'identity:wt2%3Assh%253Aone%3Ainstance',
          hostId: 'ssh:one',
          branch: 'main',
          displayName: 'Worktree'
        },
        { ref: 'id:folder-1', hostId: 'native', displayName: 'Folder' },
        { ref: 'identity:detached', hostId: 'native', displayName: 'Detached' }
      ]
    }) as { workspaces: { ref: string }[] }

    expect(listed.workspaces[1]).not.toHaveProperty('branch')
    expect(listed.workspaces[2]).not.toHaveProperty('branch')
    for (const spec of fileSpecs) {
      expect(
        spec.params.parse({ workspaceRef: listed.workspaces[0]!.ref, relativePath: 'README.md' })
      ).toMatchObject({ workspaceRef: { type: 'worktree' } })
      expect(
        spec.params.parse({ workspaceRef: listed.workspaces[1]!.ref, relativePath: 'README.md' })
      ).toMatchObject({ workspaceRef: { type: 'folder', id: 'folder-1' } })
    }
  })

  it('rejects listed references whose identity key exceeds the input bound', () => {
    expect(
      listSpec.result.safeParse({
        workspaces: [
          {
            ref: `identity:${'a'.repeat(PLUGIN_WORKSPACE_REF_KEY_MAX_LENGTH + 1)}`,
            hostId: 'native',
            branch: '',
            displayName: 'Oversized'
          }
        ]
      }).success
    ).toBe(false)
  })

  it.each([
    ['path', { path: '/private/repo' }],
    ['path-derived id', { id: 'repo::/private/repo' }],
    ['nested internal record', { git: { path: '/private/repo' } }],
    ['unknown key', { provider: 'ssh' }],
    ['workspace status', { workspaceStatus: 'ready' }],
    ['workspace comment', { comment: 'private note' }]
  ])('rejects a listed workspace containing %s', (_name, extra) => {
    expect(
      listSpec.result.safeParse({
        workspaces: [{ ref: 'id:folder-1', hostId: 'native', displayName: 'Folder', ...extra }]
      }).success
    ).toBe(false)
  })

  it.each([
    ['hostId', { hostId: 'h'.repeat(1025) }],
    ['branch', { branch: 'b'.repeat(513) }],
    ['displayName', { displayName: 'd'.repeat(513) }]
  ])('rejects a listed workspace with oversized %s', (_name, override) => {
    expect(
      listSpec.result.safeParse({
        workspaces: [
          {
            ref: 'id:folder-1',
            hostId: 'native',
            displayName: 'Folder',
            ...override
          }
        ]
      }).success
    ).toBe(false)
  })

  it('rejects the 1001st listed workspace and unknown result keys', () => {
    const workspace = { ref: 'id:folder-1', hostId: 'native', displayName: 'Folder' }
    expect(
      listSpec.result.safeParse({
        workspaces: Array.from({ length: PLUGIN_WORKSPACE_LIST_LIMIT + 1 }, () => workspace)
      }).success
    ).toBe(false)
    expect(listSpec.result.safeParse({ workspaces: [workspace], cursor: 'next' }).success).toBe(
      false
    )
  })

  it.each([
    '',
    '/etc/passwd',
    'C:\\private\\file',
    '\\\\server\\share',
    '../secret',
    'a/../b',
    'a\0b'
  ])('rejects unsafe relative path %j', (relativePath) => {
    const readSpec = PLUGIN_HOST_FILE_API_SPECS.find((spec) => spec.name === 'files.read')!
    expect(readSpec.params.safeParse({ workspaceRef: 'id:folder-1', relativePath }).success).toBe(
      false
    )
  })
})

import type * as RuntimeRpcClient from './runtime-rpc-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { floatingWorkspaceId } from '../../../shared/floating-workspace-id'
import { readFloatingMarkdownTab } from './floating-markdown-client'
import { readRuntimeFileContent } from './runtime-file-read-client'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: rpc
}))

const args = {
  settings: { activeRuntimeEnvironmentId: 'one' },
  worktreeId: floatingWorkspaceId('one'),
  filePath: '/remote/notes/plan.md',
  relativePath: 'notes/plan.md'
}
const document = {
  tabId: 'host-tab',
  filePath: args.filePath,
  relativePath: args.relativePath,
  content: '# Host draft',
  source: 'draft',
  isDirty: true,
  version: 'content:version',
  editable: true
}

beforeEach(() => {
  rpc.mockReset()
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'session.tabs.list') {
      return { tabs: [{ type: 'markdown', id: 'host-tab', filePath: args.filePath }] }
    }
    if (method === 'markdown.readTab') {
      return document
    }
    if (method === 'markdown.saveTab') {
      return { ...document, isDirty: false }
    }
    throw new Error('selector_not_found')
  })
})

describe('floating documents on older hosts', () => {
  it('reads the host tab and draft without requiring a git workspace or files.read', async () => {
    await expect(readRuntimeFileContent(args)).resolves.toEqual({
      content: '# Host draft',
      isBinary: false
    })
    expect(rpc.mock.calls.map((call) => call[1])).toEqual(['session.tabs.list', 'markdown.readTab'])
    expect(rpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'one' },
      'markdown.readTab',
      { worktree: 'id:global-floating-terminal', tabId: 'host-tab' },
      expect.any(Object)
    )
  })

  it('saves through the host tab with the version read from that same host', async () => {
    const result = await readFloatingMarkdownTab(args)
    await result?.save('# Edited')
    expect(rpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'one' },
      'markdown.saveTab',
      {
        worktree: 'id:global-floating-terminal',
        tabId: 'host-tab',
        baseVersion: 'content:version',
        content: '# Edited'
      },
      expect.any(Object)
    )
  })

  it('propagates host conflicts instead of falling back to a filesystem write', async () => {
    const result = await readFloatingMarkdownTab(args)
    rpc.mockRejectedValueOnce(new Error('conflict'))
    await expect(result?.save('edited')).rejects.toThrow('conflict')
  })

  it('never treats a truncated response as an editable document', async () => {
    rpc
      .mockResolvedValueOnce({
        tabs: [{ type: 'markdown', id: 'host-tab', filePath: args.filePath }]
      })
      .mockResolvedValueOnce({ ...document, truncated: true, byteLength: 3000000 })
    await expect(readRuntimeFileContent(args)).rejects.toThrow('too large')
  })

  it('keeps local files and unrelated hosts out of this path', async () => {
    await expect(
      readFloatingMarkdownTab({ ...args, worktreeId: 'global-floating-terminal' })
    ).resolves.toBeNull()
    await expect(
      readFloatingMarkdownTab({ ...args, settings: { activeRuntimeEnvironmentId: 'two' } })
    ).rejects.toThrow('owning runtime')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('honors host read-only state', async () => {
    rpc
      .mockResolvedValueOnce({
        tabs: [{ type: 'markdown', id: 'host-tab', filePath: args.filePath }]
      })
      .mockResolvedValueOnce({
        ...document,
        editable: false,
        readOnlyReason: 'unsupported_preview'
      })
    const result = await readFloatingMarkdownTab(args)
    await expect(result?.save('edited')).rejects.toThrow('unsupported_preview')
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it.each([null, 'two'])(
    'rejects a scoped file read routed to %s before any fallback',
    async (owner) => {
      await expect(
        readRuntimeFileContent({ ...args, settings: { activeRuntimeEnvironmentId: owner } })
      ).rejects.toThrow('owning runtime')
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it('uses the editable host tab when a preview of the same file appears first', async () => {
    rpc.mockResolvedValueOnce({
      tabs: [
        { type: 'markdown', id: 'preview', mode: 'markdown-preview', filePath: args.filePath },
        { type: 'markdown', id: 'host-tab', mode: 'edit', filePath: args.filePath }
      ]
    })
    const result = await readFloatingMarkdownTab(args)
    expect(result?.document).toEqual(document)
    expect(rpc).toHaveBeenLastCalledWith(
      expect.any(Object),
      'markdown.readTab',
      { worktree: 'id:global-floating-terminal', tabId: 'host-tab' },
      expect.any(Object)
    )
  })

  it('refuses a response for a different document', async () => {
    rpc
      .mockResolvedValueOnce({
        tabs: [{ type: 'markdown', id: 'host-tab', filePath: args.filePath }]
      })
      .mockResolvedValueOnce({ ...document, filePath: '/other/notes.md' })
    await expect(readFloatingMarkdownTab(args)).rejects.toThrow('identity changed')
  })
})

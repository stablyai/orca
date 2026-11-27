import { expect, it, vi } from 'vitest'
import type * as TerminalFilePathMapping from '@/components/terminal-pane/host-files/terminal-file-path-mapping'
import type * as TerminalHostFileLinkExistence from '@/components/terminal-pane/links/files/terminal-host-file-link-existence'
import type { ParsedTerminalFileLink } from '../../../../../../shared/terminal/links/terminal-links'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatFileLinkHost } from './native-chat-file-link-existence'

const hostFileLinkTargetExists = vi.hoisted(() => vi.fn(async () => true))
const fileContext = vi.hoisted(() => {
  const box: { current: TerminalFilePathMapping.TerminalFileContext | null } = {
    current: null
  }
  return box
})

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ worktreesByRepo: {} }), subscribe: () => () => {} }
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ worktreesByRepo: {} }), subscribe: () => () => {} }
}))
vi.mock('@/components/terminal-pane/host-files/terminal-file-path-mapping', async () => {
  const actual = await vi.importActual<typeof TerminalFilePathMapping>(
    '@/components/terminal-pane/host-files/terminal-file-path-mapping'
  )
  return {
    ...actual,
    getTerminalFileContext: () => {
      if (!fileContext.current) {
        throw new Error('file context missing')
      }
      return fileContext.current
    }
  }
})
vi.mock('@/components/terminal-pane/links/files/terminal-host-file-link-existence', async () => {
  const actual = await vi.importActual<typeof TerminalHostFileLinkExistence>(
    '@/components/terminal-pane/links/files/terminal-host-file-link-existence'
  )
  return { ...actual, hostFileLinkTargetExists }
})

const { createNativeChatFileLinkExistence } = await import('./native-chat-file-link-existence')

const SCRATCH = '/var/orca/chat-scratch/0123456789abcdef0123456789abcdef/notes.md'

function link(pathText: string): ParsedTerminalFileLink {
  return {
    pathText,
    line: null,
    column: null,
    startIndex: 0,
    endIndex: pathText.length,
    displayText: pathText
  }
}

function pairedHost(): NativeChatFileLinkHost {
  fileContext.current = {
    target: { kind: 'environment', environmentId: 'env-host' },
    worktreeId: 'wt-1',
    worktreePath: '/srv/proj',
    sourceHostResolved: true
  }
  return {
    cwd: '/srv/proj',
    worktreeId: 'wt-1',
    worktreePath: '/srv/proj',
    runtimeEnvironmentId: 'env-host',
    connectionId: null
  }
}

function localHost(): NativeChatFileLinkHost {
  fileContext.current = {
    target: { kind: 'local' },
    worktreeId: 'wt-local',
    worktreePath: '/Users/me/proj',
    sourceHostResolved: true
  }
  return {
    cwd: '/Users/me/proj',
    worktreeId: 'wt-local',
    worktreePath: '/Users/me/proj',
    runtimeEnvironmentId: null,
    connectionId: null
  }
}

async function shown(
  host: NativeChatFileLinkHost,
  pathText: string,
  pathExists: (context: RuntimeFileOperationArgs, path: string, remote: boolean) => Promise<boolean>
): Promise<boolean> {
  const existence = createNativeChatFileLinkExistence(host, pathExists)
  const watcher = existence.watch()
  const read = (): boolean => watcher.getSnapshot().check(link(pathText))
  read()
  let value = false
  await vi.waitFor(() => {
    value = read()
    expect(value).toBe(true)
  })
  return value
}

it('links a paired host path outside the workspace from the host, not this computer', async () => {
  hostFileLinkTargetExists.mockReset()
  hostFileLinkTargetExists.mockResolvedValue(true)
  const pathExists = vi.fn(async () => false)
  const host = pairedHost()

  await expect(shown(host, '/tmp/example/notes.md', pathExists)).resolves.toBe(true)

  expect(pathExists).not.toHaveBeenCalled()
  expect(hostFileLinkTargetExists).toHaveBeenCalledWith(
    expect.objectContaining({
      absolutePath: '/tmp/example/notes.md',
      isRemoteRuntimePath: false
    }),
    expect.any(Map),
    null
  )
})

it('keeps workspace and chat-scratch paths on the runtime existence check', async () => {
  hostFileLinkTargetExists.mockReset()
  hostFileLinkTargetExists.mockResolvedValue(true)
  const pathExists = vi.fn(async () => true)
  const host = pairedHost()

  await expect(shown(host, '/srv/proj/README.md', pathExists)).resolves.toBe(true)
  await expect(shown(host, SCRATCH, pathExists)).resolves.toBe(true)

  expect(hostFileLinkTargetExists).not.toHaveBeenCalled()
  expect(pathExists).toHaveBeenCalledWith(fileContext.current, '/srv/proj/README.md', true)
  expect(pathExists).toHaveBeenCalledWith(fileContext.current, SCRATCH, true)
})

it('stats a local machine path outside the workspace on this computer', async () => {
  hostFileLinkTargetExists.mockReset()
  hostFileLinkTargetExists.mockResolvedValue(true)
  const pathExists = vi.fn(async () => true)
  const host = localHost()

  await expect(shown(host, '/tmp/example/notes.md', pathExists)).resolves.toBe(true)

  expect(hostFileLinkTargetExists).not.toHaveBeenCalled()
  expect(pathExists).toHaveBeenCalledWith(fileContext.current, '/tmp/example/notes.md', false)
})

import { expect, it, vi } from 'vitest'
import type * as TerminalFilePathMapping from '@/components/terminal-pane/host-files/terminal-file-path-mapping'
import type { ParsedTerminalFileLink } from '../../../../../../shared/terminal/links/terminal-links'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatFileLinkHost } from './native-chat-file-link-existence'

const hostCalls = vi.hoisted(() => vi.fn())
const localStat = vi.hoisted(() => vi.fn(async () => ({ isDirectory: false })))
const fileContext = vi.hoisted(() => {
  const box: { current: TerminalFilePathMapping.TerminalFileContext | null } = { current: null }
  return box
})
const patch = vi.hoisted(() => async (id: string, extra: Record<string, unknown>) => ({
  ...(await vi.importActual<Record<string, unknown>>(id)),
  ...extra
}))

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ worktreesByRepo: {} }), subscribe: () => () => {} }
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ worktreesByRepo: {} }), subscribe: () => () => {} }
}))
vi.mock('@/components/terminal-pane/host-files/terminal-file-path-mapping', () =>
  patch('@/components/terminal-pane/host-files/terminal-file-path-mapping', {
    getTerminalFileContext: () => {
      if (!fileContext.current) {
        throw new Error('file context missing')
      }
      return fileContext.current
    }
  })
)
vi.mock('@/runtime/rpc/calls/host-route-call', () =>
  patch('@/runtime/rpc/calls/host-route-call', { callHostRoute: hostCalls })
)
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () =>
  patch('@/runtime/rpc/compatibility/runtime-capability-proof', {
    runtimeEnvironmentSupportsCapability: async () => true
  })
)
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () =>
  patch('@/runtime/files/metadata/runtime-file-metadata-client', { statRuntimePath: localStat })
)

const { createNativeChatFileLinkExistence } = await import('./native-chat-file-link-existence')

const SCRATCH = '/var/orca/chat-scratch/0123456789abcdef0123456789abcdef/notes.md'
const HOST_FILE = '/tmp/example/notes.md'
const LOCAL_ONLY = '/tmp/only-on-this-computer.md'

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

function useHost(remote: boolean): NativeChatFileLinkHost {
  fileContext.current = remote
    ? {
        target: { kind: 'environment', environmentId: 'env-host' },
        worktreeId: 'wt-1',
        worktreePath: '/srv/proj',
        sourceHostResolved: true
      }
    : {
        target: { kind: 'local' },
        worktreeId: 'wt-local',
        worktreePath: '/Users/me/proj',
        sourceHostResolved: true
      }
  const worktreePath = fileContext.current.worktreePath ?? ''
  return {
    cwd: worktreePath,
    worktreeId: fileContext.current.worktreeId ?? '',
    worktreePath,
    runtimeEnvironmentId: remote ? 'env-host' : null,
    connectionId: null
  }
}

function hostAnswer(pathText: string) {
  if (pathText !== HOST_FILE) {
    return {
      worktree: 'wt-1',
      relativePath: null,
      absolutePath: null,
      exists: false,
      isDirectory: false
    }
  }
  return {
    worktree: 'wt-1',
    relativePath: null,
    absolutePath: HOST_FILE,
    exists: true,
    isDirectory: false,
    openTarget: {
      kind: 'absolute-file' as const,
      provider: 'local' as const,
      absolutePath: HOST_FILE,
      grantId: 'grant-1'
    }
  }
}

async function readLink(
  host: NativeChatFileLinkHost,
  pathText: string,
  pathExists: (
    context: RuntimeFileOperationArgs,
    path: string,
    remote: boolean
  ) => Promise<boolean>,
  expectLink: boolean
): Promise<boolean> {
  const watcher = createNativeChatFileLinkExistence(host, pathExists).watch()
  const read = (): boolean => watcher.getSnapshot().check(link(pathText))
  read()
  if (expectLink) {
    await vi.waitFor(() => expect(read()).toBe(true))
  } else {
    await vi.waitFor(() => expect(hostCalls).toHaveBeenCalled())
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve()
    }
  }
  return read()
}

function armHost() {
  hostCalls.mockReset()
  localStat.mockClear()
  hostCalls.mockImplementation(async (_route, _method, params: { pathText: string }) =>
    hostAnswer(params.pathText)
  )
}

it('links a paired host path outside the workspace when the host has the file', async () => {
  armHost()
  const pathExists = vi.fn(async () => false)
  await expect(readLink(useHost(true), HOST_FILE, pathExists, true)).resolves.toBe(true)
  expect(pathExists).not.toHaveBeenCalled()
  expect(localStat).not.toHaveBeenCalled()
  expect(hostCalls).toHaveBeenCalledWith(
    expect.anything(),
    'files.resolveTerminalPath',
    expect.objectContaining({ pathText: HOST_FILE, crossWorkspace: true }),
    expect.anything()
  )
  expect(hostCalls.mock.calls[0]?.[2]).not.toHaveProperty('terminal')
})

it('does not link a same-path file that exists only on this computer', async () => {
  armHost()
  const pathExists = vi.fn(async () => true)
  await expect(readLink(useHost(true), LOCAL_ONLY, pathExists, false)).resolves.toBe(false)
  expect(pathExists).not.toHaveBeenCalled()
  expect(localStat).not.toHaveBeenCalled()
})

it('keeps workspace and chat-scratch paths on the runtime existence check', async () => {
  armHost()
  const pathExists = vi.fn(async () => true)
  const host = useHost(true)
  await expect(readLink(host, '/srv/proj/README.md', pathExists, true)).resolves.toBe(true)
  await expect(readLink(host, SCRATCH, pathExists, true)).resolves.toBe(true)
  expect(hostCalls).not.toHaveBeenCalled()
  expect(pathExists).toHaveBeenCalledWith(fileContext.current, '/srv/proj/README.md', true)
  expect(pathExists).toHaveBeenCalledWith(fileContext.current, SCRATCH, true)
})

it('stats a local machine path outside the workspace on this computer', async () => {
  armHost()
  const pathExists = vi.fn(async () => true)
  await expect(readLink(useHost(false), HOST_FILE, pathExists, true)).resolves.toBe(true)
  expect(hostCalls).not.toHaveBeenCalled()
  expect(pathExists).toHaveBeenCalledWith(fileContext.current, HOST_FILE, false)
})

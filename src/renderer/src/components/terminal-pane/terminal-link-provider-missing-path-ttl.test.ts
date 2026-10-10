import type { ILink } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { installTerminalLinkTestEnvironment } from './terminal-link-handlers-test-harness'
import { createProviderSetup, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import {
  fileLinkTargetExists,
  type FileLinkPathExistence,
  type FileLinkTarget
} from './terminal-file-link-target'
import {
  TERMINAL_PATH_MISSING_CACHE_TTL_MS,
  peekTerminalPathExistsCache,
  readTerminalPathExistsCache,
  writeTerminalPathExistsCache
} from './terminal-path-exists-cache'

const doubles = createTerminalLinkTestDoubles()
const { storeState } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: () => 'markdown'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

afterEach(() => {
  vi.restoreAllMocks()
})

function linkTexts(provider: ReturnType<typeof createProviderSetup>['provider']) {
  return new Promise<string[]>((resolve) => {
    provider.provideLinks(1, (provided?: ILink[]) =>
      resolve((provided ?? []).map((link) => link.text))
    )
  })
}

describe('terminal path-exists cache for paths that do not exist yet', () => {
  it('links a file created outside the project after its path was first printed', async () => {
    const outsidePath = '/Users/me/Documents/notes/new-file.md'
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const localPathExists = vi
      .spyOn(window.api.shell, 'pathExists')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const { provider } = createProviderSetup(
      [makeBufferLine(`Write(${outsidePath})`)],
      new Map<string, boolean>()
    )

    // Hovered while the agent waits for permission: the file is not on disk yet.
    expect(await linkTexts(provider)).toEqual([])

    // A hover moments later still uses the cached answer instead of probing again.
    now.mockReturnValue(1_000 + TERMINAL_PATH_MISSING_CACHE_TTL_MS - 1)
    expect(await linkTexts(provider)).toEqual([])
    expect(localPathExists).toHaveBeenCalledTimes(1)

    // The agent has written the file; the stale "missing" answer must not stick.
    now.mockReturnValue(1_000 + TERMINAL_PATH_MISSING_CACHE_TTL_MS)
    expect(await linkTexts(provider)).toEqual([outsidePath])
    expect(localPathExists).toHaveBeenCalledTimes(2)
  })

  it('expires missing entries but keeps existing ones', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const cache = new Map<string, boolean>()
    writeTerminalPathExistsCache(cache, 'missing', false)
    writeTerminalPathExistsCache(cache, 'present', true)

    now.mockReturnValue(TERMINAL_PATH_MISSING_CACHE_TTL_MS - 1)
    expect(peekTerminalPathExistsCache(cache, 'missing')).toBe(false)
    expect(readTerminalPathExistsCache(cache, 'missing')).toBe(false)

    now.mockReturnValue(TERMINAL_PATH_MISSING_CACHE_TTL_MS)
    expect(peekTerminalPathExistsCache(cache, 'missing')).toBeUndefined()
    expect(readTerminalPathExistsCache(cache, 'missing')).toBeUndefined()
    expect(readTerminalPathExistsCache(cache, 'present')).toBe(true)
  })

  it('starts a fresh TTL when a path that existed is later reported missing', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const cache = new Map<string, boolean>()
    writeTerminalPathExistsCache(cache, 'path', false)
    writeTerminalPathExistsCache(cache, 'path', true)

    now.mockReturnValue(TERMINAL_PATH_MISSING_CACHE_TTL_MS * 2)
    writeTerminalPathExistsCache(cache, 'path', false)
    now.mockReturnValue(TERMINAL_PATH_MISSING_CACHE_TTL_MS * 3 - 1)
    expect(readTerminalPathExistsCache(cache, 'path')).toBe(false)
  })
})

describe('fileLinkTargetExists with a missing answer', () => {
  const target: FileLinkTarget = {
    absolutePath: '/Users/me/Documents/notes/new-file.md',
    line: null,
    column: null,
    fileContext: {
      settings: null,
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      sourceHostResolved: true
    },
    isRemoteRuntimePath: false,
    cacheKey: 'active\0/Users/me/Documents/notes/new-file.md',
    isKnownWorktreeRoot: false
  }

  it('re-probes when the TTL runs out, even if cache hits happened in between', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const probe = vi
      .fn<FileLinkPathExistence>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const cache = new Map<string, boolean>()

    expect(await fileLinkTargetExists(target, cache, probe)).toBe(false)

    // A hit near the end of the window must not push the expiry out.
    now.mockReturnValue(TERMINAL_PATH_MISSING_CACHE_TTL_MS - 1)
    expect(await fileLinkTargetExists(target, cache, probe)).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)

    now.mockReturnValue(TERMINAL_PATH_MISSING_CACHE_TTL_MS)
    expect(await fileLinkTargetExists(target, cache, probe)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('never expires a non-boolean cache value', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const answers = new Map<string, { exists: boolean; generation: number }>()
    writeTerminalPathExistsCache(answers, 'chat-path', { exists: false, generation: 1 })

    now.mockReturnValue(TERMINAL_PATH_MISSING_CACHE_TTL_MS * 10)
    expect(readTerminalPathExistsCache(answers, 'chat-path')).toEqual({
      exists: false,
      generation: 1
    })
  })
})

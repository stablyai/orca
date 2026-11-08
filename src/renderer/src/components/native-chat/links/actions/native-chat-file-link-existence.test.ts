import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTerminalFileLink } from '../../../../../../shared/terminal/links/terminal-links'
import type * as FileLinkTargetModule from '@/components/terminal-pane/links/files/terminal-file-link-target'
import type { FileLinkPathExistence } from '@/components/terminal-pane/links/files/terminal-file-link-target'
import type * as FilePathMappingModule from '@/components/terminal-pane/host-files/terminal-file-path-mapping'

import { createNativeChatFileLinkExistence } from './native-chat-file-link-existence'

const connection = vi.hoisted(() => ({
  resolved: true,
  sourceHostResolved: true,
  currentOwnerResolved: true
}))

vi.mock('@/lib/connection-context', () => ({
  isWorktreeConnectionResolved: () => connection.resolved
}))

vi.mock(
  '@/components/terminal-pane/links/files/terminal-file-link-target',
  async (importOriginal) => ({
    ...(await importOriginal<typeof FileLinkTargetModule>()),
    resolveFileLinkTarget: (link: ParsedTerminalFileLink) => ({
      absolutePath: /^[\\/]{2}/.test(link.pathText) ? link.pathText : `/repo/${link.pathText}`,
      line: null,
      column: null,
      fileContext: { target: { kind: 'local' }, sourceHostResolved: connection.sourceHostResolved },
      isRemoteRuntimePath: false,
      cacheKey: link.pathText,
      isKnownWorktreeRoot: link.pathText === 'ROOT'
    })
  })
)

vi.mock(
  '@/components/terminal-pane/host-files/terminal-file-path-mapping',
  async (importOriginal) => ({
    ...(await importOriginal<typeof FilePathMappingModule>()),
    getTerminalFileContext: () => ({
      target: { kind: 'local' },
      sourceHostResolved: connection.currentOwnerResolved
    })
  })
)

const host = { cwd: '/repo', worktreeId: 'wt-1', worktreePath: '/repo', connectionId: null }

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

function hostWith(answer: (path: string) => boolean | Error) {
  const asked: string[] = []
  const pathExists = vi.fn<FileLinkPathExistence>(async (_context, path) => {
    asked.push(path)
    const result = answer(path)
    if (result instanceof Error) {
      throw result
    }
    return result
  })
  return { asked, pathExists }
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
}

function watching(existence: ReturnType<typeof createNativeChatFileLinkExistence>) {
  const watcher = existence.watch()
  const onChange = vi.fn()
  const unsubscribe = watcher.subscribe(onChange)
  return { watcher, onChange, unsubscribe }
}

describe('createNativeChatFileLinkExistence', () => {
  afterEach(() => {
    vi.useRealTimers()
    connection.resolved = true
    connection.sourceHostResolved = true
    connection.currentOwnerResolved = true
  })

  it('shows an answer that landed between a message rendering and subscribing', async () => {
    const { pathExists } = hostWith(() => true)
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    watching(existence).watcher.getSnapshot().check(link('src/App.tsx'))
    // Why: React renders (and checks) before its effect subscribes.
    const late = existence.watch()
    expect(late.getSnapshot().check(link('src/App.tsx'))).toBe(false)
    await settle()

    const onChange = vi.fn()
    late.subscribe(onChange)

    expect(onChange).toHaveBeenCalledOnce()
    expect(late.getSnapshot().check(link('src/App.tsx'))).toBe(true)
    expect(pathExists).toHaveBeenCalledOnce()
  })

  it('keeps a reply to an older question from overwriting a newer answer', async () => {
    const replies: ((exists: boolean) => void)[] = []
    const pathExists = vi.fn<FileLinkPathExistence>(
      () => new Promise<boolean>((resolve) => replies.push(resolve))
    )
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const { watcher } = watching(existence)
    watcher.getSnapshot().check(link('src/new.ts'))
    await settle()
    existence.recheck()
    await settle()
    expect(replies).toHaveLength(2)

    replies[1](true)
    await settle()
    replies[0](false)
    await settle()

    expect(watcher.getSnapshot().check(link('src/new.ts'))).toBe(true)
  })
})

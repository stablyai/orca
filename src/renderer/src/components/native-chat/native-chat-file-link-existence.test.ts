import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTerminalFileLink } from '@/lib/terminal-links'
import type * as FileLinkTargetModule from '@/components/terminal-pane/terminal-file-link-target'
import type { FileLinkPathExistence } from '@/components/terminal-pane/terminal-file-link-target'
import type * as FilePathMappingModule from '@/components/terminal-pane/terminal-file-path-mapping'
import {
  createNativeChatFileLinkExistence,
  UNVERIFIABLE_RETRY_DELAYS_MS
} from './native-chat-file-link-existence'

const connection = vi.hoisted(() => ({
  resolved: true,
  sourceHostResolved: true,
  currentOwnerResolved: true
}))

vi.mock('@/lib/connection-context', () => ({
  isWorktreeConnectionResolved: () => connection.resolved
}))

vi.mock('@/components/terminal-pane/terminal-file-link-target', async (importOriginal) => ({
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
}))

vi.mock('@/components/terminal-pane/terminal-file-path-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof FilePathMappingModule>()),
  getTerminalFileContext: () => ({
    target: { kind: 'local' },
    sourceHostResolved: connection.currentOwnerResolved
  })
}))

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

  it('underlines a path only after the host confirms it, asking once', async () => {
    const { asked, pathExists } = hostWith((path) => path === '/repo/src/App.tsx')
    const { watcher, onChange } = watching(createNativeChatFileLinkExistence(host, pathExists))

    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(false)
    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(false)
    await settle()

    expect(asked).toEqual(['/repo/src/App.tsx'])
    expect(onChange).toHaveBeenCalledOnce()
    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(true)
  })

  it('leaves a missing path plain without refreshing the message', async () => {
    const { pathExists } = hostWith(() => false)
    const { watcher, onChange } = watching(createNativeChatFileLinkExistence(host, pathExists))

    watcher.getSnapshot().check(link('src/app.ts'))
    await settle()

    expect(onChange).not.toHaveBeenCalled()
    expect(watcher.getSnapshot().check(link('src/app.ts'))).toBe(false)
    expect(pathExists).toHaveBeenCalledOnce()
  })

  it('does not recheck a held path once its workspace owner can no longer be placed', async () => {
    const { asked, pathExists } = hostWith(() => true)
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const { watcher } = watching(existence)
    watcher.getSnapshot().check(link('src/app.ts'))
    await settle()
    expect(asked).toEqual(['/repo/src/app.ts'])

    // A detected row on another host lands after the target was held, making the owner ambiguous.
    connection.currentOwnerResolved = false
    existence.recheck()
    await settle()

    expect(asked).toEqual(['/repo/src/app.ts'])
  })

  it('links a path the turn created once the turn ends, without re-rendering first', async () => {
    let created = false
    const { asked, pathExists } = hostWith(() => created)
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const { watcher, onChange } = watching(existence)
    watcher.getSnapshot().check(link('src/new.ts'))
    await settle()

    created = true
    existence.recheck()
    expect(onChange).not.toHaveBeenCalled()
    await settle()

    expect(asked).toEqual(['/repo/src/new.ts', '/repo/src/new.ts'])
    expect(onChange).toHaveBeenCalledOnce()
    expect(watcher.getSnapshot().check(link('src/new.ts'))).toBe(true)
  })

  it('removes the underline of a confirmed path deleted during the turn', async () => {
    let deleted = false
    const { pathExists } = hostWith(() => !deleted)
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const { watcher, onChange } = watching(existence)
    watcher.getSnapshot().check(link('src/old.ts'))
    await settle()
    expect(watcher.getSnapshot().check(link('src/old.ts'))).toBe(true)

    deleted = true
    existence.recheck()
    // Why: the old answer keeps showing until the host replies, so nothing flickers.
    expect(watcher.getSnapshot().check(link('src/old.ts'))).toBe(true)
    await settle()

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(watcher.getSnapshot().check(link('src/old.ts'))).toBe(false)
  })

  it('on a recheck re-renders only the messages whose answer changed', async () => {
    let deleted = false
    const { pathExists } = hostWith((path) => !(deleted && path === '/repo/src/old.ts'))
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const naming = watching(existence)
    const other = watching(existence)
    naming.watcher.getSnapshot().check(link('src/old.ts'))
    other.watcher.getSnapshot().check(link('src/kept.ts'))
    await settle()
    naming.onChange.mockClear()
    other.onChange.mockClear()

    deleted = true
    existence.recheck()
    await settle()

    expect(naming.onChange).toHaveBeenCalledOnce()
    expect(other.onChange).not.toHaveBeenCalled()
    expect(pathExists).toHaveBeenCalledTimes(4)
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

  it('asks again on subscribe when the host failed before the message subscribed', async () => {
    vi.useFakeTimers()
    let reachable = false
    const { pathExists } = hostWith(() => (reachable ? true : new Error('SSH connection closed')))
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const late = existence.watch()
    late.getSnapshot().check(link('src/App.tsx'))
    await settle()
    // Why: nothing showed the path yet, so no retry was armed for it.
    expect(vi.getTimerCount()).toBe(0)

    reachable = true
    const onChange = vi.fn()
    late.subscribe(onChange)
    await settle()

    expect(pathExists).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledOnce()
    expect(late.getSnapshot().check(link('src/App.tsx'))).toBe(true)
  })

  it('refreshes only the messages that named a confirmed path', async () => {
    const { pathExists } = hostWith(() => true)
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const naming = watching(existence)
    const other = watching(existence)

    naming.watcher.getSnapshot().check(link('src/App.tsx'))
    await settle()

    expect(naming.onChange).toHaveBeenCalledOnce()
    expect(other.onChange).not.toHaveBeenCalled()
    expect(other.watcher.getSnapshot().check(link('src/App.tsx'))).toBe(true)
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

  it('does not ask while text is still streaming in', async () => {
    const { pathExists } = hostWith(() => true)
    const existence = createNativeChatFileLinkExistence(host, pathExists)

    expect(existence.watch().getSnapshot().peek(link('src/Ap'))).toBe(false)
    await settle()

    expect(pathExists).not.toHaveBeenCalled()
  })

  it('links a path once a host that could not answer comes back, without a remount', async () => {
    vi.useFakeTimers()
    let reachable = false
    const { pathExists } = hostWith(() => (reachable ? true : new Error('SSH connection closed')))
    const { watcher, onChange } = watching(createNativeChatFileLinkExistence(host, pathExists))

    watcher.getSnapshot().check(link('src/App.tsx'))
    await settle()
    // Why: re-renders while the host is down must not ask again; the retry owns that.
    watcher.getSnapshot().check(link('src/App.tsx'))
    await settle()
    expect(pathExists).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()

    reachable = true
    await vi.advanceTimersByTimeAsync(UNVERIFIABLE_RETRY_DELAYS_MS[0])

    expect(pathExists).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledOnce()
    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(true)
  })

  it('stops retrying a host that stays down, until the next recheck', async () => {
    vi.useFakeTimers()
    const { pathExists } = hostWith(() => new Error('runtime unreachable'))
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const { watcher } = watching(existence)
    watcher.getSnapshot().check(link('src/App.tsx'))
    await settle()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(pathExists).toHaveBeenCalledTimes(1 + UNVERIFIABLE_RETRY_DELAYS_MS.length)

    existence.recheck()
    await settle()
    expect(pathExists).toHaveBeenCalledTimes(2 + UNVERIFIABLE_RETRY_DELAYS_MS.length)
  })

  it('stops retrying once no message shows the path', async () => {
    vi.useFakeTimers()
    const { pathExists } = hostWith(() => new Error('SSH connection closed'))
    const { watcher, unsubscribe } = watching(createNativeChatFileLinkExistence(host, pathExists))
    watcher.getSnapshot().check(link('src/App.tsx'))
    await settle()

    unsubscribe()
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(pathExists).toHaveBeenCalledOnce()
  })

  it('keeps the shown answer when the host cannot answer a recheck', async () => {
    let reachable = true
    const { pathExists } = hostWith(() => (reachable ? true : new Error('SSH connection closed')))
    const existence = createNativeChatFileLinkExistence(host, pathExists)
    const { watcher, onChange } = watching(existence)
    watcher.getSnapshot().check(link('src/App.tsx'))
    await settle()
    onChange.mockClear()

    reachable = false
    existence.recheck()
    await settle()

    expect(onChange).not.toHaveBeenCalled()
    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(true)
  })

  it('never checks on this machine while a remote workspace connection is unresolved', async () => {
    connection.resolved = false
    const { pathExists } = hostWith(() => true)
    const { watcher } = watching(
      createNativeChatFileLinkExistence({ ...host, connectionId: undefined }, pathExists)
    )

    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(false)
    await settle()

    expect(pathExists).not.toHaveBeenCalled()
  })

  it('never checks on this machine when same-id owners leave the source host unresolved', async () => {
    connection.sourceHostResolved = false
    const { pathExists } = hostWith(() => true)
    const { watcher } = watching(createNativeChatFileLinkExistence(host, pathExists))

    expect(watcher.getSnapshot().check(link('src/App.tsx'))).toBe(false)
    await settle()

    expect(pathExists).not.toHaveBeenCalled()
  })

  it('never asks this machine about a network share outside the workspace', async () => {
    const { pathExists } = hostWith(() => true)
    const { watcher } = watching(createNativeChatFileLinkExistence(host, pathExists))

    for (const path of [String.raw`\\evil.example\share\a.ts`, '//evil.example/share/notes.md']) {
      expect(watcher.getSnapshot().check(link(path))).toBe(false)
    }
    await settle()

    expect(pathExists).not.toHaveBeenCalled()
  })

  it('still checks paths inside a workspace on a network share, and WSL paths', async () => {
    const { asked, pathExists } = hostWith(() => true)
    const shareHost = { ...host, worktreePath: String.raw`\\FileServer\share\repo` }
    const wslHost = { ...host, worktreePath: String.raw`\\wsl.localhost\Ubuntu\home\me\repo` }
    const onShare = watching(createNativeChatFileLinkExistence(shareHost, pathExists)).watcher
    const onWsl = watching(createNativeChatFileLinkExistence(wslHost, pathExists)).watcher

    onShare.getSnapshot().check(link(String.raw`\\fileserver\share\repo\src\a.ts`))
    onWsl.getSnapshot().check(link(String.raw`\\wsl.localhost\Ubuntu\home\me\a.ts`))
    await settle()

    expect(asked).toEqual([
      String.raw`\\fileserver\share\repo\src\a.ts`,
      String.raw`\\wsl.localhost\Ubuntu\home\me\a.ts`
    ])
  })

  it('links a known workspace root without asking', () => {
    const { pathExists } = hostWith(() => false)
    const existence = createNativeChatFileLinkExistence(host, pathExists)

    expect(existence.watch().getSnapshot().check(link('ROOT'))).toBe(true)
    expect(pathExists).not.toHaveBeenCalled()
  })
})

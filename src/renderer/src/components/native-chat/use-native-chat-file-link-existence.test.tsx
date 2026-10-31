import {
  NativeChatFileLinkExistenceProvider,
  useNativeChatFileLinkExists,
  useRecheckNativeChatFileLinksWhenTurnEnds
} from './use-native-chat-file-link-existence'
import type * as TerminalFileLinkTarget from '@/components/terminal-pane/terminal-file-link-target'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ExistenceModule from './native-chat-file-link-existence'
import type { NativeChatFileLinkContext } from './native-chat-file-link'

// @vitest-environment happy-dom

type StoreState = {
  connectionId: string | null | undefined
  sshConnectionStates: Map<string, { status: string; connectionGeneration?: number }>
  runtimeStatusByEnvironmentId: Map<string, unknown>
}

const mocks = vi.hoisted(() => {
  const store: StoreState = {
    connectionId: 'ssh-1',
    sshConnectionStates: new Map(),
    runtimeStatusByEnvironmentId: new Map()
  }
  const created: { recheck: () => void }[] = []
  return { store, created, useRealExistence: false, pathExists: vi.fn(async () => false) }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.store)
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: (state: StoreState) => state.connectionId,
  isWorktreeConnectionResolved: () => true
}))
vi.mock('./use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: () => context
}))
vi.mock('./native-chat-file-link-existence', async (importOriginal) => {
  const original = await importOriginal<typeof ExistenceModule>()
  return {
    ...original,
    createNativeChatFileLinkExistence: (
      ...args: Parameters<typeof original.createNativeChatFileLinkExistence>
    ) => {
      if (mocks.useRealExistence) {
        return original.createNativeChatFileLinkExistence(args[0], mocks.pathExists)
      }
      const existence = { watch: vi.fn(), recheck: vi.fn() }
      mocks.created.push(existence)
      return existence
    }
  }
})

vi.mock('@/components/terminal-pane/terminal-file-link-target', async (importOriginal) => {
  const original = await importOriginal<typeof TerminalFileLinkTarget>()
  return {
    ...original,
    resolveFileLinkTarget: () => ({
      absolutePath: '/repo/result.txt',
      line: null,
      column: null,
      fileContext: { target: { kind: 'local' }, connectionId: 'ssh-1', sourceHostResolved: true },
      isRemoteRuntimePath: false,
      cacheKey: 'result.txt',
      isKnownWorktreeRoot: false
    })
  }
})
vi.mock('@/components/terminal-pane/terminal-file-path-mapping', () => ({
  getTerminalFileContext: () => ({
    target: { kind: 'local' },
    connectionId: 'ssh-1',
    sourceHostResolved: true
  })
}))

const context: NativeChatFileLinkContext = {
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  runtimeEnvironmentId: null
}

function TurnState({ isWorking }: { isWorking: boolean }): null {
  useRecheckNativeChatFileLinksWhenTurnEnds(isWorking)
  return null
}

function chat(isWorking: boolean): React.JSX.Element {
  return (
    <NativeChatFileLinkExistenceProvider tabId="tab-1">
      <TurnState isWorking={isWorking} />
    </NativeChatFileLinkExistenceProvider>
  )
}

function renderProvider(isWorking: boolean) {
  return render(chat(isWorking))
}

describe('NativeChatFileLinkExistenceProvider', () => {
  afterEach(() => {
    cleanup()
    mocks.created.length = 0
    mocks.useRealExistence = false
    mocks.pathExists.mockReset()
    mocks.store.connectionId = 'ssh-1'
    mocks.store.sshConnectionStates = new Map()
  })

  it('rechecks when a turn ends, not when the chat mounts', () => {
    const view = renderProvider(false)
    view.rerender(chat(true))
    expect(mocks.created[0].recheck).not.toHaveBeenCalled()

    view.rerender(chat(false))

    expect(mocks.created).toHaveLength(1)
    expect(mocks.created[0].recheck).toHaveBeenCalledOnce()
  })

  it('makes a newly created file link usable only when hidden recovery settles', async () => {
    mocks.useRealExistence = true
    mocks.pathExists.mockResolvedValue(false)
    function Link({ working }: { working: boolean }) {
      useRecheckNativeChatFileLinksWhenTurnEnds(working)
      const exists = useNativeChatFileLinkExists(true, false)
      const pathText = 'result.txt'
      const present = exists?.({
        pathText,
        displayText: pathText,
        line: null,
        column: null,
        startIndex: 0,
        endIndex: pathText.length
      })
      return present ? <a href="/repo/result.txt">result.txt</a> : <span>result.txt</span>
    }
    const chat = (working: boolean) => (
      <NativeChatFileLinkExistenceProvider tabId="tab-1">
        <Link working={working} />
      </NativeChatFileLinkExistenceProvider>
    )
    const view = render(chat(true))
    await waitFor(() => expect(mocks.pathExists).toHaveBeenCalledOnce())
    expect(view.queryByRole('link')).toBeNull()
    mocks.pathExists.mockResolvedValue(true)
    view.rerender(chat(true))
    expect(mocks.pathExists).toHaveBeenCalledOnce()
    view.rerender(chat(false))
    await waitFor(() =>
      expect(view.getByRole('link').getAttribute('href')).toBe('/repo/result.txt')
    )
    expect(mocks.pathExists).toHaveBeenCalledTimes(2)
  })

  it('rechecks when the SSH connection comes back', () => {
    mocks.store.sshConnectionStates = new Map([['ssh-1', { status: 'reconnecting' }]])
    const view = renderProvider(false)

    mocks.store.sshConnectionStates = new Map([
      ['ssh-1', { status: 'connected', connectionGeneration: 2 }]
    ])
    view.rerender(chat(false))

    expect(mocks.created[0].recheck).toHaveBeenCalledOnce()
  })

  it('does not recheck when the SSH connection drops', () => {
    mocks.store.sshConnectionStates = new Map([['ssh-1', { status: 'connected' }]])
    const view = renderProvider(false)

    for (const status of ['reconnecting', 'connecting', 'deploying-relay']) {
      mocks.store.sshConnectionStates = new Map([['ssh-1', { status }]])
      view.rerender(chat(false))
    }

    expect(mocks.created[0].recheck).not.toHaveBeenCalled()
  })

  it('starts over when the workspace connection resolves', () => {
    mocks.store.connectionId = undefined
    const view = renderProvider(false)

    mocks.store.connectionId = 'ssh-1'
    view.rerender(chat(false))

    expect(mocks.created).toHaveLength(2)
    expect(mocks.created[0].recheck).not.toHaveBeenCalled()
    expect(mocks.created[1].recheck).not.toHaveBeenCalled()
  })
})

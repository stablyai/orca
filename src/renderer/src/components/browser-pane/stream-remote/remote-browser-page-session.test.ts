import { describe, expect, it, vi } from 'vitest'
import {
  RemoteBrowserPageSession,
  type RemoteBrowserPageHandle,
  type RemoteBrowserRpcCall
} from './remote-browser-page-session'
import { RemoteBrowserOperationTokens } from './remote-browser-stream-tokens'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

/** What the host answers to tabShow for the row's own id. */
type ShowReply = 'runs' | 'not-found' | 'other-error'

function rpcError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function setup(args: { show: ShowReply; switchOn?: boolean; onShow?: () => void }) {
  layoutOwner.isMain = args.switchOn ?? true
  const tokens = new RemoteBrowserOperationTokens({
    isMounted: () => true,
    isActive: () => true,
    // A frame-drawn row is named by the host's page id.
    getTabId: () => 'host-page-1',
    getEnvironmentId: () => 'env-1',
    browserPageExists: () => true
  })
  const calls: { method: string; params: unknown }[] = []
  const closedMissing: (string | null)[] = []
  let stored: RemoteBrowserPageHandle | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake answers each method with the reply shape its caller reads.
  const callRpc = (async (_target: unknown, method: string, params?: unknown) => {
    calls.push({ method, params })
    if (method === 'browser.tabShow') {
      args.onShow?.()
      if (args.show === 'not-found') {
        throw rpcError('browser_tab_not_found')
      }
      if (args.show === 'other-error') {
        throw rpcError('request_timeout')
      }
      return { tab: { url: 'https://example.test/', title: 'Example' } }
    }
    if (method === 'browser.tabCreate') {
      return { browserPageId: 'created-page' }
    }
    return {}
  }) as unknown as RemoteBrowserRpcCall
  const session = new RemoteBrowserPageSession({
    tokens,
    callRpc,
    getWorktreeSelector: () => 'id:wt-1',
    getCurrentUrl: () => 'about:blank',
    readStoredHandle: () => stored,
    writeStoredHandle: (handle) => {
      stored = handle
    },
    removeStoredHandle: () => {
      stored = null
    },
    applyTabInfo: () => {},
    closeMissingRemotePage: (id) => closedMissing.push(id)
  })
  return {
    tokens,
    calls,
    closedMissing,
    stored: () => stored,
    ensure: () => session.ensureRemotePage(tokens.createOperationToken()!),
    methods: () => calls.map((call) => call.method)
  }
}

describe('RemoteBrowserPageSession.ensureRemotePage without a stored handle', () => {
  // A saved page a restarted host has not started is woken by this same tabShow (see
  // orca-runtime-serve-browser-restore.test.ts).
  it('adopts the page the host runs under the row id instead of creating a second one', async () => {
    const harness = setup({ show: 'runs' })

    await expect(harness.ensure()).resolves.toBe('host-page-1')

    expect(harness.methods()).toEqual(['browser.tabShow'])
    expect(harness.calls[0]?.params).toEqual({ worktree: 'id:wt-1', page: 'host-page-1' })
    expect(harness.tokens.remotePage).toBe('host-page-1')
    expect(harness.stored()).toEqual({ environmentId: 'env-1', remotePageId: 'host-page-1' })
  })

  it('creates a page when the host has none under the row id, closing nothing', async () => {
    const harness = setup({ show: 'not-found' })

    await expect(harness.ensure()).resolves.toBe('created-page')

    expect(harness.methods()).toEqual(['browser.tabShow', 'browser.tabCreate'])
    expect(harness.closedMissing).toEqual([])
    expect(harness.stored()).toEqual({ environmentId: 'env-1', remotePageId: 'created-page' })
  })

  // A timeout or transient failure says nothing about the page; creating would duplicate a live one.
  it('surfaces any other probe failure without creating a page', async () => {
    const harness = setup({ show: 'other-error' })

    await expect(harness.ensure()).rejects.toMatchObject({ code: 'request_timeout' })

    expect(harness.methods()).toEqual(['browser.tabShow'])
    expect(harness.tokens.remotePage).toBeNull()
    expect(harness.stored()).toBeNull()
    expect(harness.closedMissing).toEqual([])
  })

  it('adopts nothing when the pane moved on during the probe', async () => {
    let harness: ReturnType<typeof setup> | null = null
    harness = setup({ show: 'runs', onShow: () => harness?.tokens.supersedeOperations() })

    await expect(harness.ensure()).resolves.toBeNull()

    expect(harness.methods()).toEqual(['browser.tabShow'])
    expect(harness.stored()).toBeNull()
    expect(harness.tokens.remotePage).toBeNull()
  })

  it('keeps creating directly with the layout-owner switch off', async () => {
    const harness = setup({ show: 'runs', switchOn: false })

    await expect(harness.ensure()).resolves.toBe('created-page')

    expect(harness.methods()).toEqual(['browser.tabCreate'])
  })
})

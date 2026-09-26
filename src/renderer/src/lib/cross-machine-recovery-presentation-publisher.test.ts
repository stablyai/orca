import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RecoveryPresentationPublishParams,
  RecoveryPresentationPublishResult,
  RecoveryPresentationWorkspace
} from '../../../shared/cross-machine-recovery-presentation-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  createCrossMachineRecoveryPresentationPublisher,
  PRESENTATION_INPUT_PUBLISH_INTERVAL_MS,
  PRESENTATION_PUBLISH_BACKOFF_MAX_MS,
  PRESENTATION_PUBLISH_BACKOFF_MIN_MS,
  PRESENTATION_PUBLISH_DEBOUNCE_MS,
  PRESENTATION_PUBLISH_MAX_WAIT_MS
} from './cross-machine-recovery-presentation-publisher'

type Call = { hostId: ExecutionHostId; params: RecoveryPresentationPublishParams }

function workspace(worktreeId: string): RecoveryPresentationWorkspace {
  return {
    workspace: { kind: 'worktree', worktreeId, instanceId: 'inst-1' },
    view: {
      tabs: [],
      groups: [],
      groupLayout: null,
      activeGroupId: null,
      terminalTabs: [],
      terminalLayouts: {},
      startupCwdRelative: {},
      editors: [],
      activeEditorRelativePath: null,
      browsers: [],
      activeBrowserId: null,
      activeTabType: null,
      activeTabId: null
    },
    focus: {
      isActiveWorkspace: true,
      focusedTabId: null,
      focusedLeafId: null,
      focusedPaneKey: null,
      windowFocused: true
    },
    input: { msSinceHumanInput: null, msSinceHumanFocus: null, msSinceHumanInputByPaneKey: {} }
  }
}

function setup(
  options: {
    hosts?: ExecutionHostId[]
    localHostSupported?: boolean
    supported?: (hostId: ExecutionHostId) => boolean
    respond?: (call: Call) => Promise<RecoveryPresentationPublishResult>
  } = {}
) {
  const calls: Call[] = []
  let label = 'v1'
  const hosts = options.hosts ?? ['local']
  const supportsHost = vi.fn(async (hostId: ExecutionHostId) => options.supported?.(hostId) ?? true)
  const publisher = createCrossMachineRecoveryPresentationPublisher({
    clientInstanceId: 'client-1',
    clientName: 'Laptop',
    localHostSupported: options.localHostSupported ?? true,
    snapshot: () => new Map(hosts.map((hostId) => [hostId, [workspace(`${hostId}-${label}`)]])),
    transport: {
      supportsHost,
      publish: (hostId, params) => {
        const call = { hostId, params }
        calls.push(call)
        return (
          options.respond?.(call) ??
          Promise.resolve({
            ok: true,
            acknowledgedRevision: params.clientRevision,
            hostReceivedAt: Date.now()
          })
        )
      }
    }
  })
  return {
    publisher,
    calls,
    supportsHost,
    setLabel: (next: string) => {
      label = next
    }
  }
}

describe('createCrossMachineRecoveryPresentationPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces 50 view changes into one trailing publish', async () => {
    const { publisher, calls } = setup()
    for (let i = 0; i < 50; i++) {
      publisher.viewChanged()
      await vi.advanceTimersByTimeAsync(20)
    }
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(PRESENTATION_PUBLISH_DEBOUNCE_MS)
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toMatchObject({
      clientInstanceId: 'client-1',
      clientName: 'Laptop',
      clientRevision: 1
    })
  })

  it('publishes by the max-wait deadline under continuous changes', async () => {
    const { publisher, calls } = setup()
    for (let elapsed = 0; elapsed < PRESENTATION_PUBLISH_MAX_WAIT_MS - 500; elapsed += 500) {
      publisher.viewChanged()
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(calls).toHaveLength(0)
    publisher.viewChanged()
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toHaveLength(1)
  })

  it('publishes input-only changes at most once per interval', async () => {
    const { publisher, calls } = setup()
    publisher.viewChanged()
    await vi.advanceTimersByTimeAsync(PRESENTATION_PUBLISH_DEBOUNCE_MS)
    expect(calls).toHaveLength(1)
    for (let i = 0; i < 30; i++) {
      publisher.inputChanged()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PRESENTATION_INPUT_PUBLISH_INTERVAL_MS - 30_001)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(PRESENTATION_INPUT_PUBLISH_INTERVAL_MS)
    expect(calls).toHaveLength(2)
  })

  it('publishes a workspace focus change on the leading edge', async () => {
    const { publisher, calls } = setup()
    publisher.workspaceFocusChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    publisher.workspaceFocusChanged()
    publisher.workspaceFocusChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PRESENTATION_PUBLISH_DEBOUNCE_MS)
    expect(calls).toHaveLength(2)
  })

  it('keeps one request in flight per host and sends only the newest snapshot after it', async () => {
    const pending: ((result: RecoveryPresentationPublishResult) => void)[] = []
    const { publisher, calls, setLabel } = setup({
      respond: () => new Promise((resolve) => pending.push(resolve))
    })
    publisher.workspaceFocusChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    for (const next of ['v2', 'v3', 'v4']) {
      setLabel(next)
      publisher.viewChanged()
      await vi.advanceTimersByTimeAsync(PRESENTATION_PUBLISH_DEBOUNCE_MS)
    }
    expect(calls).toHaveLength(1)
    pending[0]({ ok: true, acknowledgedRevision: 1, hostReceivedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    expect(calls[1].params.workspaces[0].workspace).toEqual({
      kind: 'worktree',
      worktreeId: 'local-v4',
      instanceId: expect.any(String)
    })
    expect(calls[1].params.clientRevision).toBe(2)
  })

  it('never calls a host that lacks the presentation capability', async () => {
    const { publisher, calls, supportsHost } = setup({
      hosts: ['runtime:env-a'],
      supported: () => false
    })
    publisher.workspaceFocusChanged()
    await vi.advanceTimersByTimeAsync(PRESENTATION_PUBLISH_BACKOFF_MAX_MS)
    expect(supportsHost).toHaveBeenCalledWith('runtime:env-a')
    expect(calls).toHaveLength(0)
  })

  it('resends at acknowledgedRevision + 1 after a stale-revision answer', async () => {
    const { publisher, calls } = setup({
      respond: (call) =>
        Promise.resolve(
          call.params.clientRevision === 1
            ? { ok: false, reason: 'stale-revision', acknowledgedRevision: 41 }
            : {
                ok: true,
                acknowledgedRevision: call.params.clientRevision,
                hostReceivedAt: Date.now()
              }
        )
    })
    publisher.workspaceFocusChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map((call) => call.params.clientRevision)).toEqual([1, 42])
  })

  it('backs off from 5 s to 5 min while the host is unavailable', async () => {
    const { publisher, calls } = setup({
      respond: () => Promise.resolve({ ok: false, reason: 'unavailable' })
    })
    publisher.workspaceFocusChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    const expectedDelays = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]
    expect(expectedDelays[0]).toBe(PRESENTATION_PUBLISH_BACKOFF_MIN_MS)
    for (const [index, delay] of expectedDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(calls).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(index + 2)
    }
  })

  it('backs off when the transport throws, then resets after a success', async () => {
    let failing = true
    const { publisher, calls } = setup({
      respond: (call) =>
        failing
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              ok: true,
              acknowledgedRevision: call.params.clientRevision,
              hostReceivedAt: Date.now()
            })
    })
    publisher.workspaceFocusChanged()
    await vi.advanceTimersByTimeAsync(0)
    failing = false
    await vi.advanceTimersByTimeAsync(PRESENTATION_PUBLISH_BACKOFF_MIN_MS)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(PRESENTATION_PUBLISH_BACKOFF_MAX_MS)
    expect(calls).toHaveLength(2)
  })

  it('never publishes to ssh hosts, and skips local when unsupported', async () => {
    const { publisher, calls, supportsHost } = setup({
      hosts: ['ssh:box', 'local', 'runtime:env-a'],
      localHostSupported: false
    })
    publisher.workspaceFocusChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map((call) => call.hostId)).toEqual(['runtime:env-a'])
    expect(supportsHost).not.toHaveBeenCalledWith('ssh:box')
  })

  it('stops publishing after dispose', async () => {
    const { publisher, calls } = setup()
    publisher.viewChanged()
    publisher.dispose()
    await vi.advanceTimersByTimeAsync(PRESENTATION_PUBLISH_MAX_WAIT_MS)
    expect(calls).toHaveLength(0)
  })
})

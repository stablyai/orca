import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ClientWorkspaceView } from '../../../shared/rpc-contract/client-workspace-view-params'

const presence = vi.hoisted((): { remaining: number | null } => ({ remaining: 180_000 }))

vi.mock('./agent-auto-ack-presence', () => ({ presenceRemainingMs: () => presence.remaining }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/store/slices/workspace-attention/workspace-unread-flag', () => ({
  onScreenHostId: () => null
}))
vi.mock('@/store/slices/worktrees/listing/worktree-owner-target', () => ({
  tryRuntimeTargetForWorktreeOwner: (_state: unknown, workspaceId: string) =>
    workspaceId.startsWith('server:')
      ? { kind: 'environment', environmentId: 'env-1' }
      : workspaceId === 'unowned'
        ? null
        : { kind: 'local' }
}))

const { createClientWorkspaceViewReporter } = await import('./client-workspace-view-report')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: owner lookup is mocked above, so no state is read.
const STATE = {} as AppState

function reporter() {
  const sent: { target: RuntimeClientTarget; view: ClientWorkspaceView }[] = []
  const report = createClientWorkspaceViewReporter(async (target, view) => {
    sent.push({ target, view })
  })
  return { sent, report }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
  presence.remaining = 180_000
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createClientWorkspaceViewReporter', () => {
  it('sends each owning host only its own workspaces and tabs, and only when they change', () => {
    const { sent, report } = reporter()
    const targets = [
      { tabId: 'tab-a', worktreeId: 'local-wt', surfaceKind: 'terminal' as const },
      { tabId: 'tab-s', worktreeId: 'server:wt', surfaceKind: 'structured' as const },
      { tabId: 'tab-x', worktreeId: null, surfaceKind: 'terminal' as const }
    ]
    report.update(STATE, ['local-wt', 'server:wt', 'unowned'], targets)
    expect(sent).toEqual([
      {
        target: { kind: 'local' },
        view: { workspaceIds: ['local-wt'], tabIds: ['tab-a'], presentForMs: 190_000 }
      },
      {
        target: { kind: 'environment', environmentId: 'env-1' },
        view: { workspaceIds: ['server:wt'], tabIds: ['tab-s'], presentForMs: 190_000 }
      }
    ])
    report.update(STATE, ['local-wt', 'server:wt', 'unowned'], targets)
    expect(sent).toHaveLength(2)

    report.update(STATE, ['local-wt'], targets.slice(0, 1))
    report.update(STATE, ['local-wt'], targets.slice(0, 1))
    expect(sent.slice(2)).toEqual([
      {
        target: { kind: 'environment', environmentId: 'env-1' },
        view: { workspaceIds: [], tabIds: [], presentForMs: 190_000 }
      }
    ])
  })

  it('refreshes the host’s copy at most every ten seconds of activity', () => {
    const { sent, report } = reporter()
    report.update(STATE, ['local-wt'], [])
    vi.setSystemTime(Date.now() + 9_000)
    report.renewPresence()
    expect(sent).toHaveLength(1)

    vi.setSystemTime(Date.now() + 1_000)
    report.renewPresence()
    expect(sent).toHaveLength(2)
    expect(sent[1].view.presentForMs).toBe(190_000)
  })

  it('reports an away user’s screen with no presence, and renews as soon as input returns', () => {
    const { sent, report } = reporter()
    presence.remaining = 0
    report.update(STATE, ['local-wt'], [])
    expect(sent[0].view.presentForMs).toBe(0)
    report.renewPresence()
    expect(sent).toHaveLength(1)
    presence.remaining = 180_000
    report.renewPresence()
    expect(sent).toHaveLength(2)
  })

  it('refreshes where presence is not tracked too, so a reconnected host learns the view', () => {
    const { sent, report } = reporter()
    presence.remaining = null
    report.update(STATE, ['local-wt'], [])
    vi.setSystemTime(Date.now() + 10_000)
    report.renewPresence()
    expect(sent).toHaveLength(2)
    expect(sent[1].view.presentForMs).toBeNull()
  })

  it('retries a failed send, empty or not, no sooner than a refresh', async () => {
    const sent: ClientWorkspaceView[] = []
    let fail = true
    const report = createClientWorkspaceViewReporter(async (_target, view) => {
      sent.push(view)
      if (fail) {
        throw new Error('method_not_found')
      }
    })
    report.update(STATE, ['local-wt'], [])
    await Promise.resolve()
    report.renewPresence()
    expect(sent).toHaveLength(1)
    vi.setSystemTime(Date.now() + 10_000)
    report.renewPresence()
    expect(sent).toHaveLength(2)

    fail = false
    vi.setSystemTime(Date.now() + 10_000)
    report.renewPresence()
    await Promise.resolve()
    expect(sent).toHaveLength(3)

    fail = true
    report.update(STATE, [], [])
    await Promise.resolve()
    fail = false
    vi.setSystemTime(Date.now() + 10_000)
    report.renewPresence()
    expect(sent).toHaveLength(5)
    expect(sent.at(-1)?.workspaceIds).toEqual([])
  })
})

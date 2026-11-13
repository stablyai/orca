import { getPaneSpawnDeferral } from '../session-restore/spawn-deferral/pane-spawn-deferral-registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { selectCodexStaleSessionCount } from '@/components/status-bar/codex-restart-status-summary'
import { codexAccountRestartToken } from '@/store/terminals/codex-account-restart-continuation'
import {
  prepareCodexAccountRestart,
  failCodexAccountRestart,
  retryCodexAccountRestarts
} from './codex-account-restart-execution'
import {
  sweepUnclaimedCodexPaneRestarts,
  resetDetachedCodexPaneRestartClaimsForTests
} from './detached/codex-detached-pane-restart'
import { STALLED_DETACHED_RESTART_MS } from './detached/detached-pane-restart-slots'
import { formatAccountRestartFailure } from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'

const { buildStartup } = vi.hoisted(() => ({
  buildStartup: vi.fn(() => ({
    command: 'codex resume conversation-1',
    startupCommandDelivery: 'shell-ready',
    launchAgent: 'codex',
    resumeProviderSession: { id: 'conversation-1' }
  }))
}))
vi.mock('@/lib/agent-session/accounts/agent-account-restart-startup', () => ({
  captureAgentAccountRestartResumeInput: () => ({ providerSession: { id: 'conversation-1' } }),
  buildPaneAccountRestartStartup: buildStartup
}))

const leaf = '00000000-0000-4000-8000-000000000001'
const sibling = '00000000-0000-4000-8000-000000000002'
const key = `tab:${leaf}`
const spawn = vi.fn()
const call = vi.fn()
const notice = { previousAccountLabel: 'old', nextAccountLabel: 'new' }
function seed() {
  useAppStore.setState({
    tabsByWorktree: {
      wt: [
        {
          id: 'tab',
          worktreeId: 'wt',
          createdAt: 1,
          ptyId: 'old',
          title: 'Codex',
          customTitle: null,
          color: null,
          sortOrder: 0
        }
      ]
    },
    ptyIdsByTabId: { tab: ['old', 'sibling'] },
    terminalLayoutsByTabId: {
      tab: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: leaf },
          second: { type: 'leaf', leafId: sibling }
        },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'old', [sibling]: 'sibling' }
      }
    },
    codexRestartNoticeByPtyId: { old: notice },
    paneAccountRestarts: {}
  })
}
function accepted() {
  useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
  const request = useAppStore.getState().claimCodexAccountRestart(key)
  if (!request) {
    throw new Error('request not accepted')
  }
  return request
}
function receipt(
  request: ReturnType<typeof accepted>,
  stop: 'not-started' | 'confirmed-retired' | 'unknown',
  kind: 'original' | 'empty'
) {
  return new Error(
    formatAccountRestartFailure('launch refused', {
      v: 1,
      requestId: request.requestId,
      attemptId: request.attemptId,
      stop,
      outcome: 'terminal',
      current: {
        kind,
        bindingGeneration: kind === 'empty' ? 1 : 0,
        ...(kind === 'original' ? { incarnationId: 'inc-old' } : {})
      }
    })
  )
}
function snapshot(owner: { ptyId: string; incarnationId: string } | null, generation = 0) {
  return {
    ok: true,
    id: 'resolve',
    result: {
      terminal: {
        handle: 'handle-old',
        accountRestart: { hostEpoch: 'host', tabCreatedAt: 1, bindingGeneration: generation, owner }
      }
    }
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  resetDetachedCodexPaneRestartClaimsForTests()
  buildStartup.mockClear()
  call.mockReset().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
  spawn.mockReset().mockResolvedValue({ id: 'replacement' })
  vi.stubGlobal('window', { api: { pty: { spawn, kill: vi.fn() }, runtime: { call } } })
  seed()
})
afterEach(() => {
  resetDetachedCodexPaneRestartClaimsForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Codex account continuation', () => {
  it('hides accepted work, retains the captured conversation through failure, and retries a proven empty leaf', async () => {
    const request = accepted(),
      token = codexAccountRestartToken(request)
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    await prepareCodexAccountRestart(request)
    useAppStore.setState({ agentStatusByPaneKey: {} })
    failCodexAccountRestart(token, receipt(request, 'confirmed-retired', 'empty'))
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    expect(useAppStore.getState().ptyIdsByTabId.tab).toEqual(['sibling'])
    const failure = useAppStore.getState().paneAccountRestarts[key]
    if (typeof failure !== 'object') {
      throw new Error('failure not retained')
    }
    await retryCodexAccountRestarts([failure])
    call.mockResolvedValue(snapshot(null, 1))
    await sweepUnclaimedCodexPaneRestarts()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex resume conversation-1',
        spawnIntent: 'user-resume',
        resumeProviderSession: { id: 'conversation-1' },
        accountRestart: expect.objectContaining({
          expected: { kind: 'empty', bindingGeneration: 1 }
        })
      })
    )
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId).toEqual({
      [leaf]: 'replacement',
      [sibling]: 'sibling'
    })
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
  })

  it('reports pre-stop failure while keeping the exact old endpoint guarded', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'not-started', 'original')
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    expect(useAppStore.getState().ptyIdsByTabId.tab).toEqual(['old', 'sibling'])
  })

  it('discards an obsolete catch after an unrelated successor wins, including an idle shell', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab', leaf, 'idle-shell-with-input')
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'confirmed-retired', 'empty')
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
      'idle-shell-with-input'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('ignores a prior attempt after Retry and a pane closed during reconciliation', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'not-started', 'original')
    )
    useAppStore.getState().retryCodexAccountRestart(codexAccountRestartToken(request))
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'confirmed-retired', 'empty')
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    const latest = useAppStore.getState().claimCodexAccountRestart(key)
    if (!latest) {
      throw new Error('retry not accepted')
    }
    const read = Promise.withResolvers<ReturnType<typeof snapshot>>()
    call.mockReturnValue(read.promise)
    const preparing = prepareCodexAccountRestart(latest)
    useAppStore.getState().setTabLayout('tab', {
      root: { type: 'leaf', leafId: sibling },
      activeLeafId: sibling,
      expandedLeafId: null,
      ptyIdsByLeafId: { [sibling]: 'sibling' }
    })
    read.resolve(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
    await expect(preparing).resolves.toBeNull()
    expect(useAppStore.getState().paneAccountRestarts).toEqual({})
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps a stalled attempt unresolved, reconciles without duplicate launch, then adopts its late result', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<{ id: string }>()
    spawn.mockReturnValue(pending.promise)
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    const running = sweepUnclaimedCodexPaneRestarts()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(STALLED_DETACHED_RESTART_MS)
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    const unresolved = useAppStore.getState().paneAccountRestarts[key]
    if (typeof unresolved !== 'object') {
      throw new Error('attempt not retained')
    }
    await retryCodexAccountRestarts([unresolved])
    await sweepUnclaimedCodexPaneRestarts()
    expect(spawn).toHaveBeenCalledTimes(1)
    pending.resolve({ id: 'late-replacement' })
    await running
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
      'late-replacement'
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
  })
  it('retains a genuine deferred launch, then starts its captured command when resumed', async () => {
    spawn.mockRejectedValueOnce(
      new Error(
        formatAccountRestartFailure('terminal_spawn_deferred:paused', {
          v: 1,
          requestId: 'unused',
          attemptId: 'unused',
          stop: 'not-started',
          outcome: 'terminal'
        })
      )
    )
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    const queued = useAppStore.getState().paneAccountRestarts[key]
    if (typeof queued !== 'object') {
      throw new Error('missing request')
    }
    spawn.mockReset().mockRejectedValueOnce(
      new Error(
        formatAccountRestartFailure('terminal_spawn_deferred:paused', {
          v: 1,
          requestId: queued.requestId,
          attemptId: queued.attemptId,
          stop: 'not-started',
          outcome: 'terminal',
          current: { kind: 'original', bindingGeneration: 0, incarnationId: 'inc-old' }
        })
      )
    )
    await sweepUnclaimedCodexPaneRestarts()
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    expect(getPaneSpawnDeferral(key)?.reason).toBe('paused')
    spawn.mockResolvedValue({ id: 'resumed' })
    getPaneSpawnDeferral(key)?.resume()
    await sweepUnclaimedCodexPaneRestarts()
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe('resumed')
    expect(getPaneSpawnDeferral(key)).toBeUndefined()
  })
})

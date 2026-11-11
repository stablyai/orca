import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { method: string; params: unknown; environmentId: string }[] = []
let showPtyId: string | null = 'host-pty-7'
let stopResult: Record<string, unknown> = {}
let readTail: string[] = []

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (target: { environmentId: string }, method: string, params: unknown) => {
    calls.push({ method, params, environmentId: target.environmentId })
    if (method === 'terminal.read') {
      return { terminal: { tail: readTail } }
    }
    return method === 'terminal.show' ? { terminal: { ptyId: showPtyId } } : stopResult
  }
}))

vi.mock(
  '@/runtime/hosted-terminals/creation/agent-launch/agent-session-ensure-provider-session',
  () => ({ agentProviderSessionForHostEnsure: async (_env: string, session: unknown) => session })
)

const { freshIfResumeFoundNothing, resumeRemotePaneAgent, stopRemotePaneTerminalForRestart } =
  await import('./cloud-pane-restart-stop')

describe('stopRemotePaneTerminalForRestart (RA-11 paired pane)', () => {
  beforeEach(() => {
    calls.length = 0
    showPtyId = 'host-pty-7'
    stopResult = { stoppedPtyIds: ['host-pty-7'], postStopVerified: true }
  })

  it('puts exactly that one host terminal to sleep (reversible, target only), never a close', async () => {
    await stopRemotePaneTerminalForRestart('remote:env-1@@term_a', 'wt-1')
    expect(calls.map((c) => c.method)).toEqual(['terminal.show', 'terminal.stopExact'])
    expect(calls[0]).toMatchObject({ environmentId: 'env-1', params: { terminal: 'term_a' } })
    expect(calls[1]).toMatchObject({
      environmentId: 'env-1',
      params: { expectedPtyIds: ['host-pty-7'], keepHistory: true, targetOnly: true }
    })
  })

  it('throws when the host has no live terminal for the pane, or does not confirm the stop', async () => {
    showPtyId = null
    await expect(stopRemotePaneTerminalForRestart('remote:env-1@@term_a', 'wt-1')).rejects.toThrow(
      'restart_remote_pane_not_live'
    )
    showPtyId = 'host-pty-7'
    stopResult = { stoppedPtyIds: ['host-pty-7'], postStopVerified: false }
    await expect(stopRemotePaneTerminalForRestart('remote:env-1@@term_a', 'wt-1')).rejects.toThrow()
  })

  it('refuses a pane id without an owning environment', async () => {
    await expect(stopRemotePaneTerminalForRestart('remote:term_a', 'wt-1')).rejects.toThrow(
      'restart_remote_pane_unowned'
    )
    expect(calls).toEqual([])
  })
})

describe('resumeRemotePaneAgent (RA-11 paired pane)', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('ensures the agent on its own session, placed in the same host tab and leaf', async () => {
    await resumeRemotePaneAgent({
      ptyId: 'remote:env-1@@term_a',
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab%3A%3Aleaf',
      leafId: 'leaf-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'terminal.ensureAgentSession',
      environmentId: 'env-1',
      params: {
        kind: 'explicit',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-1' },
        placement: { tabId: 'host-tab::leaf', leafId: 'leaf-1' }
      }
    })
  })
})

describe('freshIfResumeFoundNothing (RA-11e)', () => {
  const sleep = () => Promise.resolve()
  let clock = 0
  const now = () => (clock += 1_000)
  beforeEach(() => {
    calls.length = 0
    clock = 0
  })

  it('a resume that found no conversation starts the agent fresh in the same pane, once', async () => {
    readTail = ['$ claude --resume s1', 'No conversation found with session ID: s1', '$ ']
    const relaunched = await freshIfResumeFoundNothing({
      currentPtyId: () => 'remote:env-1@@term_new',
      replacedPtyId: 'remote:env-1@@term_old',
      freshCommand: 'claude --dangerously-skip-permissions',
      sleep,
      now
    })
    expect(relaunched).toBe(true)
    const sends = calls.filter((c) => c.method === 'terminal.send')
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({
      environmentId: 'env-1',
      params: { terminal: 'term_new', text: 'claude --dangerously-skip-permissions', enter: true }
    })
  })

  it('ANSI-coloured output and a late message (after 15 s) are still caught', async () => {
    readTail = ['\u001b[31mNo conversation found with session ID: s1\u001b[39m', '$ ']
    let reads = 0
    const relaunched = await freshIfResumeFoundNothing({
      // The pane binds its new terminal only after 15 s.
      currentPtyId: () => (++reads > 15 ? 'remote:env-1@@term_new' : 'remote:env-1@@term_old'),
      replacedPtyId: 'remote:env-1@@term_old',
      freshCommand: 'claude',
      sleep,
      now
    })
    expect(relaunched).toBe(true)
    expect(calls.filter((c) => c.method === 'terminal.send')).toHaveLength(1)
  })

  it('a resume that worked is left alone', async () => {
    readTail = ['Claude Code v2.1.319', '❯ say hi 1']
    const relaunched = await freshIfResumeFoundNothing({
      currentPtyId: () => 'remote:env-1@@term_new',
      replacedPtyId: 'remote:env-1@@term_old',
      freshCommand: 'claude',
      sleep,
      now
    })
    expect(relaunched).toBe(false)
    expect(calls.some((c) => c.method === 'terminal.send')).toBe(false)
  })

  it('never reads the old terminal: waits for the pane to bind a new PTY', async () => {
    readTail = ['No conversation found with session ID: s1']
    const relaunched = await freshIfResumeFoundNothing({
      currentPtyId: () => 'remote:env-1@@term_old',
      replacedPtyId: 'remote:env-1@@term_old',
      freshCommand: 'claude',
      sleep,
      now
    })
    expect(relaunched).toBe(false)
    expect(calls).toEqual([])
  })
})

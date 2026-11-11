import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { method: string; params: unknown; environmentId: string }[] = []
let showPtyId: string | null = 'host-pty-7'
let stopResult: Record<string, unknown> = {}
let readTail: string[] = []
/** How each terminal.send answers, in order ('ok' once the list runs out). */
let sendAnswers: ('ok' | 'timeout' | 'refused')[] = []
/** Tail the host shows after the nth send (the fresh agent came up), if set. */
let tailAfterSend: string[] | null = null
/** What each terminal.ensureAgentSession answers, in order. */
let ensureAnswers: { handle: string; disposition: 'created' | 'adopted' }[] = []
/** What terminal.list answers, per call (the last one repeats). */
let listAnswers: { handle: string; tabId: string; leafId: string; connected?: boolean }[][] = []

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (target: { environmentId: string }, method: string, params: unknown) => {
    calls.push({ method, params, environmentId: target.environmentId })
    if (method === 'terminal.read') {
      return { terminal: { tail: readTail } }
    }
    if (method === 'terminal.ensureAgentSession') {
      const answer = ensureAnswers.shift() ?? { handle: 'term_resumed', disposition: 'created' }
      return { terminal: { handle: answer.handle }, disposition: answer.disposition }
    }
    if (method === 'terminal.list') {
      const answer = listAnswers.length > 1 ? listAnswers.shift() : listAnswers[0]
      return { terminals: answer ?? [] }
    }
    if (method === 'terminal.send') {
      if (tailAfterSend) {
        readTail = tailAfterSend
      }
      const answer = sendAnswers.shift() ?? 'ok'
      if (answer === 'timeout') {
        throw new Error('Timed out waiting for the remote Orca runtime to respond.')
      }
      return { send: { handle: 'term_new', accepted: answer === 'ok', bytesWritten: 0 } }
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
const { waitForResumedTerminalReady } = await import('./cloud-resumed-terminal-ready')

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

const RESUME_ARGS = {
  ptyId: 'remote:env-1@@term_a',
  worktreeId: 'wt-1',
  tabId: 'web-terminal-host-tab%3A%3Aleaf',
  leafId: 'leaf-1',
  agent: 'claude' as const,
  providerSession: { key: 'session_id' as const, id: 'sess-1' }
}

describe('resumeRemotePaneAgent (RA-11 paired pane)', () => {
  beforeEach(() => {
    calls.length = 0
    ensureAnswers = []
    showPtyId = 'host-pty-7'
    stopResult = { stoppedPtyIds: ['host-pty-7'], postStopVerified: true }
  })

  it('returns the terminal the host ensured, so the pane can bind exactly it', async () => {
    ensureAnswers = [{ handle: 'term_resumed', disposition: 'created' }]
    await expect(resumeRemotePaneAgent(RESUME_ARGS)).resolves.toEqual({
      handle: 'term_resumed',
      disposition: 'created'
    })
  })

  it('an adopted live terminal (the resume never ran) is stopped and the resume ensured once more', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    ensureAnswers = [
      { handle: 'term_original', disposition: 'adopted' },
      { handle: 'term_resumed', disposition: 'created' }
    ]
    await expect(resumeRemotePaneAgent(RESUME_ARGS)).resolves.toEqual({
      handle: 'term_resumed',
      disposition: 'created'
    })
    expect(calls.map((c) => c.method)).toEqual([
      'terminal.ensureAgentSession',
      'terminal.show',
      'terminal.stopExact',
      'terminal.ensureAgentSession'
    ])
    expect(calls[1]).toMatchObject({ params: { terminal: 'term_original' } })
    warn.mockRestore()
  })

  it('adopted twice fails the restart (never a silent new conversation)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    ensureAnswers = [
      { handle: 'term_original', disposition: 'adopted' },
      { handle: 'term_original2', disposition: 'adopted' }
    ]
    await expect(resumeRemotePaneAgent(RESUME_ARGS)).rejects.toThrow('restart_resume_adopted')
    expect(calls.filter((c) => c.method === 'terminal.ensureAgentSession')).toHaveLength(2)
    warn.mockRestore()
  })

  it('RA-11d: carries the pane’s own launch args (model, effort, flags), never the host defaults', async () => {
    await resumeRemotePaneAgent({
      ptyId: 'remote:env-1@@term_a',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      launchConfig: {
        agentArgs: '--model opus --effort high --dangerously-skip-permissions',
        agentEnv: {}
      }
    })
    expect(calls.at(-1)).toMatchObject({
      method: 'terminal.ensureAgentSession',
      params: { agentArgs: '--model opus --effort high --dangerously-skip-permissions' }
    })
  })

  it('without a recorded launch it sends no args, so the host keeps its own', async () => {
    await resumeRemotePaneAgent({
      ptyId: 'remote:env-1@@term_a',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' }
    })
    expect(calls.at(-1)?.params).not.toHaveProperty('agentArgs')
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

describe('waitForResumedTerminalReady (RA-11 resume race)', () => {
  const sleep = () => Promise.resolve()
  let clock = 0
  const now = () => (clock += 300)
  const args = {
    ptyId: 'remote:env-1@@term_a',
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab%3A%3Aleaf',
    leafId: 'leaf-1',
    handle: 'term_resumed',
    sleep,
    now
  }
  beforeEach(() => {
    calls.length = 0
    clock = 0
    listAnswers = []
  })

  it('waits until the ensured terminal itself is live in the pane’s own tab and leaf', async () => {
    listAnswers = [
      [],
      // Some other terminal ready in the leaf is not enough.
      [{ handle: 'term_original', tabId: 'host-tab::leaf', leafId: 'leaf-1' }],
      [{ handle: 'term_resumed', tabId: 'host-tab::leaf', leafId: 'leaf-1', connected: true }]
    ]
    await expect(waitForResumedTerminalReady(args)).resolves.toBeUndefined()
    expect(calls.filter((c) => c.method === 'terminal.list')).toHaveLength(3)
    expect(calls[0]).toMatchObject({ params: { handles: ['term_resumed'] } })
  })

  it('throws when the ensured terminal never shows in that leaf', async () => {
    listAnswers = [[{ handle: 'term_resumed', tabId: 'host-tab::leaf', leafId: 'other-leaf' }]]
    await expect(waitForResumedTerminalReady(args)).rejects.toThrow('restart_resume_not_ready')
  })
})

describe('freshIfResumeFoundNothing (RA-11e)', () => {
  const sleep = () => Promise.resolve()
  let clock = 0
  const now = () => (clock += 1_000)
  beforeEach(() => {
    calls.length = 0
    clock = 0
    sendAnswers = []
    tailAfterSend = null
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
      // Enter rides in the text: `enter: true` makes the host wait for the exited Claude's composer.
      params: { terminal: 'term_new', text: 'claude --dangerously-skip-permissions\r' }
    })
    expect(sends[0]?.params).not.toHaveProperty('enter')
  })

  it('a send that times out once is tried again and the fresh start lands', async () => {
    readTail = ['No conversation found with session ID: s1', '$ ']
    sendAnswers = ['timeout', 'ok']
    const relaunched = await freshIfResumeFoundNothing({
      currentPtyId: () => 'remote:env-1@@term_new',
      replacedPtyId: 'remote:env-1@@term_old',
      freshCommand: 'claude',
      sleep,
      now
    })
    expect(relaunched).toBe(true)
    expect(calls.filter((c) => c.method === 'terminal.send')).toHaveLength(2)
  })

  it('a refused send counts as a failed try', async () => {
    readTail = ['No conversation found with session ID: s1', '$ ']
    sendAnswers = ['refused', 'ok']
    await expect(
      freshIfResumeFoundNothing({
        currentPtyId: () => 'remote:env-1@@term_new',
        replacedPtyId: 'remote:env-1@@term_old',
        freshCommand: 'claude',
        sleep,
        now
      })
    ).resolves.toBe(true)
    expect(calls.filter((c) => c.method === 'terminal.send')).toHaveLength(2)
  })

  it('never types twice: a timed-out send whose Claude came up anyway is not sent again', async () => {
    readTail = ['No conversation found with session ID: s1', '$ ']
    sendAnswers = ['timeout']
    tailAfterSend = [
      'No conversation found with session ID: s1',
      '$ claude',
      'Claude Code v2.1.319'
    ]
    const relaunched = await freshIfResumeFoundNothing({
      currentPtyId: () => 'remote:env-1@@term_new',
      replacedPtyId: 'remote:env-1@@term_old',
      freshCommand: 'claude',
      sleep,
      now
    })
    expect(relaunched).toBe(true)
    expect(calls.filter((c) => c.method === 'terminal.send')).toHaveLength(1)
  })

  it('every try failing throws, so the caller shows Couldn’t restart instead of a quiet shell', async () => {
    readTail = ['No conversation found with session ID: s1', '$ ']
    sendAnswers = ['timeout', 'timeout', 'timeout']
    await expect(
      freshIfResumeFoundNothing({
        currentPtyId: () => 'remote:env-1@@term_new',
        replacedPtyId: 'remote:env-1@@term_old',
        freshCommand: 'claude',
        sleep,
        now
      })
    ).rejects.toThrow('ra11e_fresh_send_failed')
    expect(calls.filter((c) => c.method === 'terminal.send')).toHaveLength(3)
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

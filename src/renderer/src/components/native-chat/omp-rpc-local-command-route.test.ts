import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ompRpcExecutableCommands } from './omp-rpc-command-catalog'
import {
  resolveOmpRpcCommandRoute,
  runOmpLocalCommand,
  shouldRouteOmpLocalCommand
} from './omp-rpc-local-command-route'

const runLocalCommand = vi.fn()

beforeEach(() => {
  runLocalCommand.mockReset()
  ;(globalThis as { window?: unknown }).window = { api: { ompRpc: { runLocalCommand } } }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('shouldRouteOmpLocalCommand', () => {
  it('routes /usage on an omp pane off the PTY path', () => {
    expect(shouldRouteOmpLocalCommand('omp', '/usage')).toBe(true)
    expect(shouldRouteOmpLocalCommand('omp', '  /usage  ')).toBe(true)
    expect(shouldRouteOmpLocalCommand('omp', '/USAGE')).toBe(true)
  })

  it('leaves every other omp command on the existing path', () => {
    for (const command of [
      '/help',
      '/clear',
      '/compact',
      '/model opus',
      '/usage --json',
      'hello'
    ]) {
      expect(shouldRouteOmpLocalCommand('omp', command)).toBe(false)
    }
  })

  it('never routes for a non-omp agent, even for /usage', () => {
    for (const agent of ['claude', 'codex', 'grok', 'openclaude', 'pi']) {
      expect(shouldRouteOmpLocalCommand(agent, '/usage')).toBe(false)
    }
  })

  it('yields /usage to the owning session once its catalog proves the session runs it', () => {
    const executableCommands = ompRpcExecutableCommands([{ name: 'usage' }])
    expect(
      shouldRouteOmpLocalCommand('omp', '/usage', { isRpcOwned: true, executableCommands })
    ).toBe(false)
    // No catalog: the probe is still the only route that can answer.
    expect(shouldRouteOmpLocalCommand('omp', '/usage', { isRpcOwned: true })).toBe(true)
  })
})

describe('runOmpLocalCommand', () => {
  it('returns the probe output and the wire agentInvoked flag', async () => {
    runLocalCommand.mockResolvedValue({
      ok: true,
      outputText: '```\nUsage\n```',
      agentInvoked: false
    })

    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toEqual({
      outputText: '```\nUsage\n```',
      agentInvoked: false
    })
    expect(runLocalCommand).toHaveBeenCalledWith({ cwd: '/work/a', command: '/usage' })
  })

  it('carries the truncation flag through', async () => {
    runLocalCommand.mockResolvedValue({
      ok: true,
      outputText: 'partial',
      agentInvoked: false,
      truncated: true
    })
    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toEqual({
      outputText: 'partial',
      agentInvoked: false,
      truncated: true
    })
  })

  it('signals PTY fallback with null when there is no cwd, no result, or a rejection', async () => {
    await expect(runOmpLocalCommand(null, '/usage')).resolves.toBeNull()
    expect(runLocalCommand).not.toHaveBeenCalled()

    runLocalCommand.mockResolvedValue({ ok: false, errorCode: 'executable-not-found' })
    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toBeNull()

    runLocalCommand.mockRejectedValue(new Error('ipc down'))
    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toBeNull()
  })

  it('falls back when the preload api is absent entirely', async () => {
    ;(globalThis as { window?: unknown }).window = {}
    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toBeNull()
  })
})

describe('resolveOmpRpcCommandRoute', () => {
  it('keeps every non-omp pane on the PTY path, owned or not', () => {
    for (const agent of ['claude', 'codex', 'grok', 'openclaude', 'pi']) {
      expect(resolveOmpRpcCommandRoute({ agent, text: '/usage', isRpcOwned: false })).toBe('pty')
      expect(resolveOmpRpcCommandRoute({ agent, text: '/help', isRpcOwned: true })).toBe('pty')
    }
  })

  it('runs the session-less allowlist on the probe when no session owns the pane', () => {
    // The probe child is spawned with `noSession`, so it never contends with the
    // owning session for the same session file — `/usage` needs no ownership.
    expect(resolveOmpRpcCommandRoute({ agent: 'omp', text: '/usage', isRpcOwned: false })).toBe(
      'probe'
    )
    expect(resolveOmpRpcCommandRoute({ agent: 'omp', text: '  /USAGE ', isRpcOwned: false })).toBe(
      'probe'
    )
  })

  it('prefers the owning session for /usage once the catalog proves it runs there', () => {
    // The probe answers for a session it is not in; the owning session is both
    // alive and the one whose usage the pane is asking about, so it wins — and
    // unlike the probe it cannot leave an acquired, PTY-less pane with no route.
    const executableCommands = ompRpcExecutableCommands([{ name: 'usage' }])
    expect(
      resolveOmpRpcCommandRoute({
        agent: 'omp',
        text: '/usage',
        isRpcOwned: true,
        executableCommands
      })
    ).toBe('session')
  })

  it('falls back to the probe for /usage while the owning session has published no catalog', () => {
    for (const executableCommands of [null, undefined]) {
      expect(
        resolveOmpRpcCommandRoute({
          agent: 'omp',
          text: '  /USAGE ',
          isRpcOwned: true,
          executableCommands
        })
      ).toBe('probe')
    }
  })

  it('routes an RPC-executable command through the owning session', () => {
    const executableCommands = ompRpcExecutableCommands([
      { name: 'help' },
      { name: 'model' },
      { name: 'rename' }
    ])
    for (const text of ['/help', '/model opus', '/rename parity']) {
      expect(
        resolveOmpRpcCommandRoute({ agent: 'omp', text, isRpcOwned: true, executableCommands })
      ).toBe('session')
    }
  })

  it('keeps a command OMP omits from its RPC catalog off the session route', () => {
    // OMP drops any builtin without a text-mode handler from the catalog
    // (available-commands.ts), so /clear and /compact have no RPC route at all
    // — sending them as a prompt would fall through to the model.
    const executableCommands = ompRpcExecutableCommands([{ name: 'help' }, { name: 'model' }])
    for (const text of ['/clear', '/compact', '/not-a-real-command']) {
      expect(
        resolveOmpRpcCommandRoute({ agent: 'omp', text, isRpcOwned: true, executableCommands })
      ).toBe('pty')
    }
  })

  it('refuses the session route while the catalog cannot prove the command runs there', () => {
    // Unknown is not permission: `/help` with no published catalog would reach
    // session.prompt unverified, exactly as `/clear` does once one arrives.
    const empty = { names: new Set<string>(), colonSplitNames: new Set<string>() }
    for (const executableCommands of [null, undefined, empty]) {
      expect(
        resolveOmpRpcCommandRoute({
          agent: 'omp',
          text: '/help',
          isRpcOwned: true,
          executableCommands
        })
      ).toBe('pty')
    }
  })

  it('keeps /usage on the probe when the catalog omits it', () => {
    expect(
      resolveOmpRpcCommandRoute({
        agent: 'omp',
        text: '/usage',
        isRpcOwned: true,
        executableCommands: ompRpcExecutableCommands([{ name: 'help' }])
      })
    ).toBe('probe')
  })

  it('leaves those same commands on the PTY path while nothing owns the pane', () => {
    for (const text of ['/help', '/clear', '/model opus', '/usage --json']) {
      expect(resolveOmpRpcCommandRoute({ agent: 'omp', text, isRpcOwned: false })).toBe('pty')
    }
  })

  it('agrees with shouldRouteOmpLocalCommand on the probe route', () => {
    const executableCommands = ompRpcExecutableCommands([{ name: 'usage' }, { name: 'help' }])
    for (const isRpcOwned of [false, true]) {
      for (const text of ['/usage', '/help', '/usage --json', 'hello']) {
        expect(shouldRouteOmpLocalCommand('omp', text, { isRpcOwned, executableCommands })).toBe(
          resolveOmpRpcCommandRoute({ agent: 'omp', text, isRpcOwned, executableCommands }) ===
            'probe'
        )
      }
    }
  })
})

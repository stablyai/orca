import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchSpawnRequest } from '../../../../shared/agent-launch-spawn-request'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'

// The transport's agentLaunch field is typed to the fresh-spawn request, but a
// resume variant rides the same wire at runtime (its true type is erased at the
// lifecycle-deps boundary upstream); cast to exercise the runtime forwarding.
const resumeVariant = {
  resume: {
    operation: 'resume',
    sessionKey: { worktreeId: 'wt-1', baseAgent: 'codex', providerSessionId: 'sess-1' }
  }
} as unknown as AgentLaunchSpawnRequest

const legacyLaunchConfig: SleepingAgentLaunchConfig = {
  agentCommand: 'codex --resume sess-1',
  agentArgs: '--resume sess-1',
  agentEnv: { CODEX_PROFILE: 'captured' }
}

describe('createIpcPtyTransport agentLaunch legacy handoff', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('sends only the resume variant for a v1-era record (no legacy config on the wire)', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({ agentLaunch: resumeVariant })
    await transport.connect({ url: '', callbacks: {} })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agentLaunch: resumeVariant }))
    expect(spawn).toHaveBeenCalledWith(
      expect.not.objectContaining({ launchConfig: expect.anything() })
    )
    expect(spawn).toHaveBeenCalledWith(
      expect.not.objectContaining({ legacyResumeRecordedConnectionId: expect.anything() })
    )
    transport.disconnect()
  })

  it('rides a legacy record config + recorded owner alongside the resume variant', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({
      agentLaunch: resumeVariant,
      launchConfig: legacyLaunchConfig,
      legacyResumeRecordedConnectionId: 'ssh-host-1'
    })
    await transport.connect({ url: '', callbacks: {} })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentLaunch: resumeVariant,
        launchConfig: legacyLaunchConfig,
        legacyResumeRecordedConnectionId: 'ssh-host-1'
      })
    )
    transport.disconnect()
  })

  it('forwards a null recorded owner (local legacy record) rather than dropping it', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({ agentLaunch: resumeVariant })
    // Cold-restore surfaces the recorded owner per connect() call, not at
    // construction; null (a local legacy record) must survive as null.
    await transport.connect({
      url: '',
      callbacks: {},
      launchConfig: legacyLaunchConfig,
      legacyResumeRecordedConnectionId: null
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        launchConfig: legacyLaunchConfig,
        legacyResumeRecordedConnectionId: null
      })
    )
    transport.disconnect()
  })
})

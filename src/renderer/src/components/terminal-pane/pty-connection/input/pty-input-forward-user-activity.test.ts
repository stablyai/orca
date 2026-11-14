import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./codex-pane-stale', () => ({ isCodexPaneStale: () => false }))
vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({ isPtyLocked: () => false }))
vi.mock('../../snapshots/replay-guard', () => ({ isPaneReplaying: () => false }))
vi.mock('../../input/terminal-input-quarantine', () => ({
  shouldDropQuarantinedTerminalInput: () => false
}))

describe('admitted xterm user activity', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T23:59:59Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function createPaneInput(ptyId: string, accepted: boolean) {
    const observations: unknown[][] = []
    vi.stubGlobal('window', {
      api: { pty: { noteUserInput: (...payload: unknown[]) => observations.push(payload) } }
    })
    let onUserInput = (): void => undefined
    let onData = (_data: string): void => undefined
    const writes: string[] = []
    const transport = {
      getPtyId: () => ptyId,
      sendInput: (data: string) => {
        writes.push(data)
        return accepted
      }
    }
    const session = {
      pane: {
        id: 'pane-1',
        terminal: {
          _core: {
            coreService: {
              onUserInput: (listener: () => void) => {
                onUserInput = listener
                return { dispose: () => undefined }
              }
            }
          },
          onData: (listener: (data: string) => void) => {
            onData = listener
            return { dispose: () => undefined }
          }
        }
      },
      deps: {},
      transport,
      noteTerminalInputForPty: () => undefined,
      pendingTerminalInputIntentFor: () => undefined,
      inferIntentFromExactTerminalInput: () => undefined,
      claimViewportForUserActivity: () => undefined,
      markAcceptedTerminalInputSent: () => undefined,
      observeAcceptedShellCommandInput: () => undefined,
      observeAcceptedTerminalInput: () => undefined,
      observeSentTerminalInputIntent: () => undefined,
      clearPendingTerminalInputIntent: () => undefined,
      requestRecoveryForUndeliverableInput: () => undefined
    }
    const { installPtyInputForward } = await import('./pty-input-forward')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements every member used by the ordinary-input path.
    installPtyInputForward(session as never)
    return {
      observations,
      writes,
      transport,
      type: (data: string) => {
        onUserInput()
        onData(data)
      },
      report: (data: string) => onData(data)
    }
  }

  it.each(['local-pty', 'remote:host@@terminal-1'])(
    'observes genuine admitted typing for %s without reporting bytes',
    async (ptyId) => {
      const input = await createPaneInput(ptyId, true)
      input.transport.sendInput('programmatic command\r')
      input.report('\x1b[O')
      expect(input.observations).toEqual([])

      input.type('private prompt\r')
      input.type('more typing')
      expect(input.observations).toEqual([[]])
      expect(input.writes).toEqual([
        'programmatic command\r',
        '\x1b[O',
        'private prompt\r',
        'more typing'
      ])

      vi.setSystemTime(new Date('2026-11-09T00:00:01Z'))
      input.type('activity immediately after UTC midnight')
      expect(input.observations).toEqual([[], []])
    }
  )

  it('does not observe rejected transport admission', async () => {
    const input = await createPaneInput('local-pty', false)
    input.type('blocked input')
    expect(input.observations).toEqual([])
    expect(input.writes).toEqual(['blocked input'])
  })

  it('keeps typing working if the observation bridge throws', async () => {
    const input = await createPaneInput('local-pty', true)
    window.api.pty.noteUserInput = () => {
      throw new Error('bridge unavailable')
    }
    expect(() => input.type('still delivered')).not.toThrow()
    expect(input.writes).toEqual(['still delivered'])
  })
})

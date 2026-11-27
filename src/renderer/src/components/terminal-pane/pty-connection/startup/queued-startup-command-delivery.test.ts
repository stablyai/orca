import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { prepareQueuedStartupCommand } from './prepare-queued-startup-command'
import { bindQueuedStartupCommandDelivery } from './queued-startup-command-delivery'

vi.mock('./prepare-queued-startup-command', () => ({ prepareQueuedStartupCommand: vi.fn() }))
vi.mock('@/lib/workspace/creation/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

afterEach(() => {
  vi.useRealTimers()
})

it('never delivers a withheld restore when further output arrives', async () => {
  vi.useFakeTimers()
  vi.mocked(prepareQueuedStartupCommand)
    .mockResolvedValueOnce({ preparedCommand: null })
    .mockResolvedValue({ preparedCommand: "'/home/user/bin/claude' --resume saved" })
  const transport = { getPtyId: () => 'pty', sendInput: vi.fn(() => true) }
  const fixture = {
    pane: { id: 1 },
    deps: { paneTransportsRef: { current: new Map([[1, transport]]) } },
    transport,
    pendingStartupCommand: { command: 'claude --resume saved', restoring: true },
    transportStreamGeneration: 1,
    startupInjectTimer: null,
    withholdStartupDraftPaste: () => {},
    notifyBlockedStartup: () => {},
    armStartupDraftReadinessObservation: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery reads only the fixture's pane, deps, transport and startup fields.
  const session = fixture as unknown as ConnectPanePtySession
  bindQueuedStartupCommandDelivery(session)
  session.schedulePendingStartupCommandDelivery()
  await vi.advanceTimersByTimeAsync(50)
  session.schedulePendingStartupCommandDelivery()
  await vi.advanceTimersByTimeAsync(50)
  expect(session.pendingStartupCommand).toBeNull()
  expect(transport.sendInput).not.toHaveBeenCalled()
})

// Without this wiring the credential-prompt paste guard is dead code: it would find no pane for
// any ptyId and wave every paste through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRendererParityTerminal,
  writeToTerminal
} from '../../../../../shared/terminal-restore-parity-fixture'
import { readPtyVisibleScreenText } from '../pty-visible-screen-registry'
import { bindRegisterPaneSerializer } from './pane-serializer-register'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

async function buildSession(
  disposed = false
): Promise<{ session: ConnectPanePtySession; dispose: () => void }> {
  const { terminal, serializeAddon } = createRendererParityTerminal({ cols: 120, rows: 24 })
  await writeToTerminal(terminal, '\x1b[H\x1b[2JEnter your API key:')
  const onDataDisposable = { dispose: vi.fn() }
  const session = {
    disposed,
    pane: { terminal, serializeAddon },
    onDataDisposable,
    rendererOrderedPtyId: null,
    rendererOrderedSeq: null,
    kittyKeyboardModes: { hasProvenBaseline: false, snapshotFlags: undefined },
    clearHiddenOutputRestoreState: vi.fn()
  } as unknown as ConnectPanePtySession
  bindRegisterPaneSerializer(session)
  return { session, dispose: () => session.onDataDisposable.dispose() }
}

describe('bindRegisterPaneSerializer', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        pty: {
          onClearBufferRequest: vi.fn(),
          onSerializeBufferRequest: vi.fn(),
          sendSerializedBuffer: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('publishes the pane screen the paste guard reads', async () => {
    const { session } = await buildSession()
    session.registerPaneSerializerFor('pty-1')
    expect(readPtyVisibleScreenText('pty-1')).toBe('Enter your API key:')
  })

  it('withdraws the pane screen when the PTY binding is disposed', async () => {
    const { session, dispose } = await buildSession()
    session.registerPaneSerializerFor('pty-2')
    dispose()
    expect(readPtyVisibleScreenText('pty-2')).toBeNull()
  })

  it('never publishes a torn-down StrictMode first mount', async () => {
    const { session } = await buildSession(true)
    session.registerPaneSerializerFor('pty-3')
    expect(readPtyVisibleScreenText('pty-3')).toBeNull()
  })
})

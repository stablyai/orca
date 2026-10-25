import { describe, expect, it, vi } from 'vitest'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { installTerminalMouseEncodingTracker } from '@/lib/pane-manager/terminal-mouse-encoding-tracker'
import type { SerializeFn } from '../pty-buffer-serializer'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindRegisterPaneSerializer } from './pane-serializer-register'

const serializers = vi.hoisted(() => new Map<string, SerializeFn>())

vi.mock('../pty-buffer-serializer', () => ({
  registerPtySerializer: (ptyId: string, fn: SerializeFn) => {
    serializers.set(ptyId, fn)
    return () => serializers.delete(ptyId)
  },
  registerPtyTitleSource: () => () => {}
}))

const ESC = '\x1b'
const CODEX_MOUSE_START = `${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1015h${ESC}[?1006h`

async function serializePaneAfter(output: string): Promise<string> {
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  installTerminalMouseEncodingTracker(terminal)
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)
  await new Promise<void>((resolve) => terminal.write(output, resolve))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the serializer reads only these members of the session bag.
  const session = {
    disposed: false,
    pane: { terminal, serializeAddon },
    rendererOrderedPtyId: null,
    kittyKeyboardModes: { hasProvenBaseline: false },
    transport: {},
    onDataDisposable: { dispose: () => {} }
  } as unknown as ConnectPanePtySession
  bindRegisterPaneSerializer(session)
  session.registerPaneSerializerFor('pty-1')
  const result = await serializers.get('pty-1')?.()
  if (!result) {
    throw new Error('serializer returned nothing')
  }
  return result.data
}

describe('pane serializer mouse encoding', () => {
  it('carries the SGR encoding after the alternate screen a reader replays from', async () => {
    const data = await serializePaneAfter(`shell prompt\r\n${CODEX_MOUSE_START}codex`)
    expect(data).toContain(`${ESC}[?1003h`)
    expect(data.endsWith(`${ESC}[?1006h`)).toBe(true)
    expect(data.lastIndexOf(`${ESC}[?1006h`)).toBeGreaterThan(data.lastIndexOf(`${ESC}[?1049h`))
  })

  it('states the default encoding while a program tracks the mouse', async () => {
    const data = await serializePaneAfter(`${ESC}[?1049h${ESC}[?1003hlegacy`)
    expect(data).not.toContain(`${ESC}[?1006h`)
    expect(data.endsWith(`${ESC}[?1006l`)).toBe(true)
  })

  it('adds nothing when no program tracks the mouse', async () => {
    const data = await serializePaneAfter('plain shell')
    expect(data).not.toContain(`${ESC}[?1006`)
    expect(data).not.toContain(`${ESC}[?1016`)
  })

  it('keeps an empty snapshot empty', async () => {
    expect(await serializePaneAfter(`${ESC}[?1006h`)).toBe('')
  })
})

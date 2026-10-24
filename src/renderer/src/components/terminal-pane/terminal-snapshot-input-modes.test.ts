import { Terminal } from '@xterm/headless'
import { buildMouseEncodingRestoreSequence } from '../../../../shared/terminal-mouse-encoding'
import { describe, expect, it } from 'vitest'
import {
  buildParityMainBufferSnapshot,
  createRendererParityTerminal,
  writeToTerminal
} from '../../../../shared/terminal-restore-parity-fixture'
import {
  buildPostReplayLiveAgentReattachReset,
  buildSnapshotReplayPrologue,
  RESET_AFTER_BYTE_GAP
} from '../../../../shared/terminal-mode-reset-profiles'
import {
  buildFoldedImageReplayWrites,
  buildMainModelSnapshotReplayWrites
} from './terminal-snapshot-replay-paint'

const reportingModes = [
  { name: 'none', sequence: '' },
  { name: 'x10', sequence: '\x1b[?9h' },
  { name: 'vt200', sequence: '\x1b[?1000h' },
  { name: 'drag', sequence: '\x1b[?1002h' },
  { name: 'any', sequence: '\x1b[?1003h' }
] as const

describe('authoritative snapshot input modes (#18424)', () => {
  for (const sourceAlternate of [false, true]) {
    for (const targetAlternate of [false, true]) {
      for (const mode of reportingModes) {
        for (const layout of ['folded', 'split'] as const) {
          it(`${layout}: ${sourceAlternate ? 'alt' : 'normal'} to ${targetAlternate ? 'alt' : 'normal'} adopts ${mode.name} reporting despite a stale agent title`, async () => {
            const model = createRendererParityTerminal({ cols: 40, rows: 6 })
            const renderer = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
            try {
              const liveReporting = mode.name !== 'none'
              await writeToTerminal(
                model.terminal,
                `${targetAlternate ? '\x1b[?1049h' : ''}HOST_FRAME${mode.sequence}${liveReporting ? '\x1b[?1004h' : ''}`
              )
              const snapshot = buildParityMainBufferSnapshot(model, 1)
              await writeToTerminal(
                renderer,
                `${sourceAlternate ? '\x1b[?1049h' : ''}\x1b]0;Claude Code\x07\x1b[?1003h\x1b[?1006h\x1b[?1004hOLD_FRAME`
              )
              expect(renderer.modes.mouseTrackingMode).toBe('any')
              expect(renderer.modes.sendFocusMode).toBe(true)

              const folded = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
              const image = buildFoldedImageReplayWrites(folded, sourceAlternate, true)
              const writes =
                layout === 'folded'
                  ? [image.preamble, image.payload]
                  : buildMainModelSnapshotReplayWrites(snapshot, {
                      paneOnAlternateScreen: sourceAlternate
                    })
              for (const write of writes) {
                await writeToTerminal(renderer, write)
              }
              // A persisted agent title still selects this preserving epilogue.
              await writeToTerminal(renderer, buildPostReplayLiveAgentReattachReset(snapshot.data))

              expect(renderer.modes.mouseTrackingMode).toBe(mode.name)
              expect(renderer.modes.sendFocusMode).toBe(liveReporting)
              expect(renderer.buffer.active.type).toBe(targetAlternate ? 'alternate' : 'normal')
              expect(renderer.buffer.active.getLine(0)?.translateToString(true)).toBe('HOST_FRAME')
            } finally {
              model.terminal.dispose()
              renderer.dispose()
            }
          })
        }
      }
    }
  }

  it('keeps live reporting when only an alternate-screen frame is replayed', async () => {
    const renderer = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    try {
      await writeToTerminal(renderer, '\x1b[?1049h\x1b[?1003h\x1b[?1004hOLD')
      const frame = '\x1b[?1049hNEW\x1b[?1002h\x1b[?1006h\x1b[?1004h'
      const image = buildFoldedImageReplayWrites(`history${frame}`, true, false)
      await writeToTerminal(renderer, image.preamble)
      await writeToTerminal(renderer, image.payload)
      expect(renderer.modes.mouseTrackingMode).toBe('drag')
      expect(renderer.modes.sendFocusMode).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it.each([undefined, 1006, 1016])('adopts snapshot mouse encoding %s', async (encoding) => {
    const renderer = new Terminal({ allowProposedApi: true })
    const replies: string[] = []
    renderer.onData((data) => replies.push(data))
    try {
      await writeToTerminal(renderer, '\x1b[?1003h\x1b[?1006h\x1b[?1016h')
      await writeToTerminal(
        renderer,
        buildSnapshotReplayPrologue({ targetAlternateScreen: false, paneOnAlternateScreen: false })
      )
      // Current hosts state the default encoding when tracking is active.
      const restoreEncoding =
        encoding === undefined
          ? '\x1b[?1006l'
          : buildMouseEncodingRestoreSequence(encoding === 1006 ? 'sgr' : 'sgr-pixels')
      await writeToTerminal(renderer, `\x1b[?1003h${restoreEncoding}`)
      await writeToTerminal(renderer, '\x1b[?1006$p\x1b[?1016$p')
      expect(renderer.modes.mouseTrackingMode).toBe('any')
      expect(replies).toEqual([
        `\x1b[?1006;${encoding === 1006 ? 1 : 2}$y`,
        `\x1b[?1016;${encoding === 1016 ? 1 : 2}$y`
      ])
    } finally {
      renderer.dispose()
    }
  })

  it.each(['folded', 'split'] as const)(
    '%s preserves the encoding when a live snapshot from an older host omits it',
    async (layout) => {
      const renderer = new Terminal({ allowProposedApi: true })
      const replies: string[] = []
      renderer.onData((data) => replies.push(data))
      try {
        await writeToTerminal(renderer, '\x1b[?1003h\x1b[?1006h\x1b[?1004h')
        const data = 'LIVE_FRAME\x1b[?1002h\x1b[?1004h'
        const image = buildFoldedImageReplayWrites(data, false, true)
        const writes =
          layout === 'folded'
            ? [image.preamble, image.payload]
            : buildMainModelSnapshotReplayWrites({ data }, { paneOnAlternateScreen: false })
        for (const write of writes) {
          await writeToTerminal(renderer, write)
        }
        await writeToTerminal(renderer, '\x1b[?1006$p')
        expect(renderer.modes.mouseTrackingMode).toBe('drag')
        expect(renderer.modes.sendFocusMode).toBe(true)
        expect(replies).toEqual(['\x1b[?1006;1$y'])
      } finally {
        renderer.dispose()
      }
    }
  )

  it('keeps reporting when draining a byte gap without an authoritative snapshot', async () => {
    const renderer = new Terminal({ allowProposedApi: true })
    try {
      await writeToTerminal(renderer, '\x1b[?1003h\x1b[?1004h')
      await writeToTerminal(renderer, RESET_AFTER_BYTE_GAP)
      expect(renderer.modes.mouseTrackingMode).toBe('any')
      expect(renderer.modes.sendFocusMode).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it('re-arms live modes when a too-wide alternate frame is omitted', async () => {
    const renderer = new Terminal({ allowProposedApi: true })
    try {
      const writes = buildMainModelSnapshotReplayWrites(
        {
          data: 'OMITTED_FRAME',
          frameRestoreAnsi: '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h',
          alternateScreen: true,
          scrollbackAnsi: 'HISTORY'
        },
        { paneOnAlternateScreen: false, skipAltFrame: true }
      )
      for (const write of writes) {
        await writeToTerminal(renderer, write)
      }
      expect(renderer.modes.mouseTrackingMode).toBe('any')
      expect(renderer.modes.sendFocusMode).toBe(true)
      expect(renderer.buffer.active.getLine(0)?.translateToString(true)).toBe('')
    } finally {
      renderer.dispose()
    }
  })
})

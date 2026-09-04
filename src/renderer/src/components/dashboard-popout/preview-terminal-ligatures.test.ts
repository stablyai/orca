import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

import { syncPreviewTerminalLigatures } from './preview-terminal-ligatures'
import { TerminalContextualShapingAddon } from '../../lib/pane-manager/terminal-contextual-shaping-addon'
import { TerminalLigaturesAddon } from '../../lib/pane-manager/terminal-ligatures-addon'

describe('syncPreviewTerminalLigatures', () => {
  let disposed: string[]
  let ligaturesDisposeSpy: ReturnType<typeof vi.spyOn>
  let shapingDisposeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    disposed = []
    ligaturesDisposeSpy = vi
      .spyOn(TerminalLigaturesAddon.prototype, 'dispose')
      .mockImplementation(function (this: TerminalLigaturesAddon) {
        disposed.push('ligatures')
      })
    shapingDisposeSpy = vi
      .spyOn(TerminalContextualShapingAddon.prototype, 'dispose')
      .mockImplementation(function (this: TerminalContextualShapingAddon) {
        disposed.push('shaping')
      })
  })

  function createTerminal(loadAddonImpl: () => void): Terminal {
    return {
      rows: 24,
      refresh: vi.fn(),
      loadAddon: vi.fn(loadAddonImpl)
    } as unknown as Terminal
  }

  const fastMonoSettings = {
    terminalLigatures: true,
    terminalFontFamily: 'Fast Mono'
  } as unknown as GlobalSettings

  it('rolls back a partially loaded pair when the shaping addon fails to load', () => {
    let calls = 0
    const terminal = createTerminal(() => {
      calls += 1
      if (calls === 2) {
        throw new Error('load failed')
      }
    })
    syncPreviewTerminalLigatures(terminal, fastMonoSettings)
    expect(ligaturesDisposeSpy).toHaveBeenCalledTimes(1)
    expect(shapingDisposeSpy).toHaveBeenCalledTimes(1)
    expect(disposed).toEqual(['shaping', 'ligatures'])
  })

  it('does not dispose addons on a clean attach', () => {
    const terminal = createTerminal(() => undefined)
    syncPreviewTerminalLigatures(terminal, fastMonoSettings)
    expect(ligaturesDisposeSpy).not.toHaveBeenCalled()
    expect(shapingDisposeSpy).not.toHaveBeenCalled()
  })

  it('retries cleanly after a failed attach instead of stacking joiners', () => {
    let calls = 0
    const terminal = createTerminal(() => {
      calls += 1
      if (calls === 2) {
        throw new Error('first attach fails')
      }
    })
    syncPreviewTerminalLigatures(terminal, fastMonoSettings)
    expect(disposed).toEqual(['shaping', 'ligatures'])

    // The entry was forgotten, so the next call rebuilds from scratch.
    const cleanTerminal = createTerminal(() => undefined)
    syncPreviewTerminalLigatures(cleanTerminal, fastMonoSettings)
    expect(disposed).toHaveLength(2)
    expect(ligaturesDisposeSpy).toHaveBeenCalledTimes(1)
    expect(shapingDisposeSpy).toHaveBeenCalledTimes(1)
  })

  it('detaches and disposes both addons when the setting turns off', () => {
    const terminal = createTerminal(() => undefined)
    const disabled = { terminalLigatures: false } as unknown as GlobalSettings
    syncPreviewTerminalLigatures(terminal, fastMonoSettings)
    syncPreviewTerminalLigatures(terminal, disabled)
    expect(disposed).toEqual(['shaping', 'ligatures'])
  })
})
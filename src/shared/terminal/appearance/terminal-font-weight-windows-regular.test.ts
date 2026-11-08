import { describe, expect, it } from 'vitest'
import { migrateWindowsTerminalFontWeight } from './terminal-font-weight-windows-regular'

describe('migrateWindowsTerminalFontWeight', () => {
  it('moves the old Windows default to Regular once and queues the notice', () => {
    const migrated = migrateWindowsTerminalFontWeight({ terminalFontWeight: 500 }, 'win32')
    expect(migrated).toEqual({
      terminalFontWeight: 400,
      terminalFontWeightWindowsRegular: 'notice-pending'
    })
    expect(
      migrateWindowsTerminalFontWeight({ ...migrated, terminalFontWeight: 500 }, 'win32')
    ).toEqual({})
  })

  it('keeps custom weights and fresh profiles without a notice', () => {
    expect(migrateWindowsTerminalFontWeight({ terminalFontWeight: 600 }, 'win32')).toEqual({
      terminalFontWeightWindowsRegular: 'done'
    })
    expect(migrateWindowsTerminalFontWeight(undefined, 'win32')).toEqual({
      terminalFontWeightWindowsRegular: 'done'
    })
  })

  it('leaves macOS and Linux profiles untouched', () => {
    expect(migrateWindowsTerminalFontWeight({ terminalFontWeight: 500 }, 'darwin')).toEqual({})
    expect(migrateWindowsTerminalFontWeight({ terminalFontWeight: 500 }, 'linux')).toEqual({})
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const settings: { current: Partial<GlobalSettings> } = { current: {} }
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: settings.current }) }
}))

const { readTerminalClipboardSelection } = await import('./terminal-clipboard-selection-text')

const GUTTERED = ['  Retry limit is now 5.', '  Backoff starts at 2s.'].join('\n')

describe('readTerminalClipboardSelection', () => {
  beforeEach(() => {
    settings.current = {}
  })

  it('copies screen cells verbatim when the setting is off', () => {
    settings.current = { terminalCopyTrimsGutter: false }
    expect(readTerminalClipboardSelection({ getSelection: () => GUTTERED })).toBe(GUTTERED)
  })
})

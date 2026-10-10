import { describe, expect, it, vi } from 'vitest'

// Why a locale stand-in: the banner's own chrome is already translated, so the only way to see the
// mixed-language regression (#9194) is to render the message through a non-English catalog.
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string) =>
    key === 'auto.components.terminal.pane.TerminalErrorToast.remoteTerminalClosed'
      ? '远程终端已关闭。'
      : fallback
}))

import { humanizeTerminalError } from './TerminalErrorToast'

describe('remote-closed terminal banner localization', () => {
  it('translates the remote-closed line instead of pinning it to English', () => {
    expect(humanizeTerminalError('Remote terminal was closed.')).toBe('远程终端已关闭。')
  })

  it('translates the line when it is accumulated with other errors', () => {
    expect(humanizeTerminalError('Paste failed.\nRemote terminal was closed.')).toBe(
      'Paste failed.\n远程终端已关闭。'
    )
  })
})

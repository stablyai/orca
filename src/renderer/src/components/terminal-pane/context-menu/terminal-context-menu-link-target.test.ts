import { describe, expect, it } from 'vitest'
import {
  getTerminalContextMenuLinkCopyText,
  type TerminalContextMenuLinkTarget
} from './terminal-context-menu-link-target'

describe('getTerminalContextMenuLinkCopyText', () => {
  it('copies the full URL for http targets', () => {
    const target: TerminalContextMenuLinkTarget = {
      kind: 'http',
      url: 'https://example.com/path?q=1'
    }
    expect(getTerminalContextMenuLinkCopyText(target)).toBe('https://example.com/path?q=1')
  })

  it('copies the absolute path for file targets', () => {
    const target: TerminalContextMenuLinkTarget = {
      kind: 'file',
      absolutePath: '/tmp/repo/src/main.ts',
      line: 12,
      column: 3,
      pathText: 'src/main.ts:12:3'
    }
    expect(getTerminalContextMenuLinkCopyText(target)).toBe('/tmp/repo/src/main.ts')
  })
})

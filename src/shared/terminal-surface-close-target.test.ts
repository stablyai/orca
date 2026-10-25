import { describe, expect, it } from 'vitest'
import { parseTerminalSurfaceCloseTarget } from './terminal-surface-close-target'

describe('parseTerminalSurfaceCloseTarget', () => {
  it('keeps a well-formed tab or pane target', () => {
    expect(parseTerminalSurfaceCloseTarget({ kind: 'tab', tabId: 't', leafId: 'x' })).toEqual({
      kind: 'tab',
      tabId: 't'
    })
    expect(parseTerminalSurfaceCloseTarget({ kind: 'pane', tabId: 't', leafId: 'l' })).toEqual({
      kind: 'pane',
      tabId: 't',
      leafId: 'l'
    })
  })

  it.each([
    null,
    'tab',
    { tabId: 't' },
    { kind: 'tab', tabId: '' },
    { kind: 'pane', tabId: 't' },
    { kind: 'pane', tabId: 't', leafId: '' },
    { kind: 'leaf', tabId: 't', leafId: 'l' }
  ])('rejects %j', (value) => {
    expect(parseTerminalSurfaceCloseTarget(value)).toBeNull()
  })
})

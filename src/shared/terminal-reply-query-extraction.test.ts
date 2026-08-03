import { describe, expect, it } from 'vitest'
import {
  extractHiddenStartupRendererQueryData,
  HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS
} from './terminal-reply-query-extraction'

describe('extractHiddenStartupRendererQueryData', () => {
  it('carries a CSI query split across chunks', () => {
    const first = extractHiddenStartupRendererQueryData('output\x1b[6', '')
    expect(first.pending).toBe('\x1b[6')
    expect(first.statefulQueryData).toBe('')

    const second = extractHiddenStartupRendererQueryData('n', first.pending)
    expect(second.statefulQueryData).toBe('\x1b[6n')
    expect(second.pending).toBe('')
  })

  it('carries a partial OSC color query across chunks', () => {
    const first = extractHiddenStartupRendererQueryData('\x1b]11;', '')
    expect(first.pending).toBe('\x1b]11;')

    const second = extractHiddenStartupRendererQueryData('?\x07', first.pending)
    expect(second.oscColorQueryData).toBe('\x1b]11;?\x07')
    expect(second.pending).toBe('')
  })

  it('bounds the carried pending prefix', () => {
    const { pending } = extractHiddenStartupRendererQueryData(`\x1b[${'1;'.repeat(200)}`, '')
    expect(pending.length).toBe(HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS)
  })
})

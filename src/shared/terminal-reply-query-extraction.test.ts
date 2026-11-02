import { describe, expect, it } from 'vitest'
import {
  containsStatefulRendererQuery,
  extractHiddenStartupRendererQueryData
} from './terminal-reply-query-extraction'

describe('reply query extraction after an aborted CSI', () => {
  it('finds a CPR that follows a carried partial CSI', () => {
    const result = extractHiddenStartupRendererQueryData('\x1b[6n', '\x1b[38;2;177;1')

    expect(result.statefulQueryData).toBe('\x1b[6n')
    expect(result.pending).toBe('')
  })

  it('reports a CPR that follows a truncated CSI in the same chunk', () => {
    expect(containsStatefulRendererQuery('\x1b[38;2;1\x1b[6n')).toBe(true)
  })
})

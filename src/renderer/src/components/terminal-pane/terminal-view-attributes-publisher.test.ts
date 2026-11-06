/** Match xterm ThemeService defaults, cursor blend and palette while publishing app-global changes only once (terminal-query-authority.md). */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { terminalViewColorQueryReplyColors } from '../../../../shared/terminal/protocol/queries/terminal-view-attributes'

import {
  _resetTerminalViewAttributesPublisherForTest,
  publishTerminalViewAttributes,
  subscribeToPublishedTerminalViewAttributes
} from './terminal-view-attributes-publisher'

const cursorSettings = {
  terminalCursorStyle: 'block' as const,
  terminalCursorBlink: true
}

beforeEach(() => {
  _resetTerminalViewAttributesPublisherForTest()
  vi.unstubAllGlobals()
})

describe('publishTerminalViewAttributes dedupe', () => {
  it('does not record a failed send, so the next call retries', () => {
    const failingSend = vi.fn(() => false)
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings, failingSend)).toBe(false)

    const send = vi.fn(() => true)
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings, send)).toBe(true)
  })

  it('hands each published appearance to subscribers, starting with the current one', () => {
    const send = vi.fn(() => true)
    publishTerminalViewAttributes({ foreground: '#111111' }, 'dark', cursorSettings, send)
    const heard: unknown[] = []

    const unsubscribe = subscribeToPublishedTerminalViewAttributes((attributes) =>
      heard.push(terminalViewColorQueryReplyColors(attributes))
    )
    publishTerminalViewAttributes({ foreground: '#222222' }, 'dark', cursorSettings, send)
    unsubscribe()
    publishTerminalViewAttributes({ foreground: '#333333' }, 'dark', cursorSettings, send)

    expect(heard).toEqual([
      { foreground: '#111111', background: '#000000' },
      { foreground: '#222222', background: '#000000' }
    ])
  })
})

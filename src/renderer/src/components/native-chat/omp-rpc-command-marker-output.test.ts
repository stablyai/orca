import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendCommandMarkerCache,
  clearCommandMarkerCacheForTests,
  commandMarkersAsMessages
} from './native-chat-command-marker'
import { stripNoiseMessages } from './native-chat-noise'

const SCOPE = { paneKey: 'tab:leaf', agent: 'omp', sessionId: 'session-1' }

function textOf(markers: ReturnType<typeof commandMarkersAsMessages>): string {
  return markers[0].blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

beforeEach(() => {
  clearCommandMarkerCacheForTests()
})

describe('command markers carrying RPC output', () => {
  it('renders the output and an explicit agent-not-invoked completion', () => {
    const markers = appendCommandMarkerCache(SCOPE, '/usage', 10, {
      outputText: '```\nTokens: 120k\n```',
      agentInvoked: false
    })

    const messages = commandMarkersAsMessages(markers)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'command:10-1',
      // A system aside, not an assistant turn: no model reply was fabricated.
      role: 'system',
      timestamp: 10,
      source: 'scrape'
    })
    expect(textOf(messages)).toBe(
      'Ran /usage\n\n```\nTokens: 120k\n```\n\nLocal command — agent not invoked'
    )
  })

  it('keeps the output as one text block so the list renders it as markdown', () => {
    const markers = appendCommandMarkerCache(SCOPE, '/usage', 10, {
      outputText: '```\nfenced\n```',
      agentInvoked: false
    })
    const blocks = commandMarkersAsMessages(markers)[0].blocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
  })

  it('appends a truncation note when the probe capped the output', () => {
    const markers = appendCommandMarkerCache(SCOPE, '/usage', 10, {
      outputText: 'partial',
      agentInvoked: false,
      truncated: true
    })
    expect(textOf(commandMarkersAsMessages(markers))).toContain('_Output truncated._')
  })

  it('omits the completion note when the wire says the agent WAS invoked', () => {
    const markers = appendCommandMarkerCache(SCOPE, '/usage', 10, {
      outputText: 'body',
      agentInvoked: true
    })
    expect(textOf(commandMarkersAsMessages(markers))).toBe('Ran /usage\n\nbody')
  })

  it('leaves the PTY path unchanged: no outcome means the bare Ran line', () => {
    const markers = appendCommandMarkerCache(SCOPE, '/help', 10)
    expect(markers[0]).toEqual({ id: '10-1', command: '/help', sentAt: 10 })
    expect(textOf(commandMarkersAsMessages(markers))).toBe('Ran /help')
  })

  it('skips an empty output rather than emitting a blank paragraph', () => {
    const markers = appendCommandMarkerCache(SCOPE, '/usage', 10, {
      outputText: '   ',
      agentInvoked: false
    })
    expect(textOf(commandMarkersAsMessages(markers))).toBe(
      'Ran /usage\n\nLocal command — agent not invoked'
    )
  })

  it('survives harness-noise stripping, which the message list applies', () => {
    const markers = appendCommandMarkerCache(SCOPE, '/usage', 10, {
      outputText: '```\nTokens: 120k\n```',
      agentInvoked: false
    })
    expect(stripNoiseMessages(commandMarkersAsMessages(markers))).toHaveLength(1)
  })
})

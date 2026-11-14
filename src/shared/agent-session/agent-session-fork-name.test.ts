import { describe, expect, it } from 'vitest'
import { agentSessionShownName } from './agent-session-fork-name'

const legacyFork = { sessionId: 'source' }

describe('agentSessionShownName', () => {
  it('drops the suffix an older build appended to a fork of the named source', () => {
    expect(
      agentSessionShownName(
        { conversationName: 'Annotate capabilities fork', forkedFrom: legacyFork },
        'Annotate capabilities'
      )
    ).toBe('Annotate capabilities')
  })

  it('drops it from an older fork of an unnamed source titled with the default label', () => {
    expect(
      agentSessionShownName(
        { conversationName: 'Claude Chat fork', forkedFrom: legacyFork },
        'Claude Chat'
      )
    ).toBe('Claude Chat')
  })

  it('drops only one suffix from an older fork of an older fork', () => {
    expect(
      agentSessionShownName(
        { conversationName: 'Annotate fork fork', forkedFrom: legacyFork },
        'Annotate fork'
      )
    ).toBe('Annotate fork')
  })

  it('drops it from an older fork of a source whose name the old build truncated', () => {
    const source = 'a'.repeat(200)
    expect(
      agentSessionShownName(
        { conversationName: `${'a'.repeat(195)} fork`, forkedFrom: legacyFork },
        source
      )
    ).toBe(source)
  })

  it('keeps a name the user typed, even one ending in " fork"', () => {
    expect(
      agentSessionShownName(
        {
          conversationName: 'Annotate fork',
          conversationNameSource: 'user',
          forkedFrom: legacyFork
        },
        'Annotate'
      )
    ).toBe('Annotate fork')
  })

  it('keeps a plain-named fork whose source is itself named "... fork"', () => {
    expect(
      agentSessionShownName(
        {
          conversationName: 'Project fork',
          forkedFrom: { sessionId: 'source', plainName: true }
        },
        'Project'
      )
    ).toBe('Project fork')
  })

  it('keeps an older fork whose source has since been renamed', () => {
    expect(
      agentSessionShownName(
        { conversationName: 'Annotate fork', forkedFrom: legacyFork },
        'Annotate v2'
      )
    ).toBe('Annotate fork')
  })

  it('keeps the saved name when the source is unknown or the chat is not a fork', () => {
    expect(
      agentSessionShownName(
        { conversationName: 'Annotate fork', forkedFrom: legacyFork },
        undefined
      )
    ).toBe('Annotate fork')
    expect(
      agentSessionShownName({ conversationName: 'Annotate fork', forkedFrom: null }, 'Annotate')
    ).toBe('Annotate fork')
  })
})

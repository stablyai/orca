import { describe, it, expect } from 'vitest'
import {
  scrapeScrollbackToMessages,
  scrapeNativeChatSession,
  stripScrollbackAnsi
} from './native-chat-scrape-fallback'

const ESC = String.fromCharCode(27)

describe('scrapeScrollbackToMessages', () => {
  it('strips ANSI escapes and segments into >1 ordered messages', () => {
    const raw = [
      `${ESC}[32m$ run the build${ESC}[0m`,
      '',
      `${ESC}[1mBuilding project...${ESC}[0m`,
      'Done in 2s.'
    ].join('\n')

    const messages = scrapeScrollbackToMessages(raw)

    expect(messages.length).toBeGreaterThan(1)
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.type === 'text') {
          // ANSI is gone — no raw escape character survives.
          expect(block.text).not.toContain(ESC)
        }
      }
    }
    // Order is preserved from the scrollback.
    expect(messages[0].id).toBe('scrape-0')
    expect(messages[1].id).toBe('scrape-1')
  })

  it('returns an empty list for empty / whitespace scrollback without throwing', () => {
    expect(scrapeScrollbackToMessages('')).toEqual([])
    expect(scrapeScrollbackToMessages('   \n\t  \n')).toEqual([])
  })

  it('marks every produced message with source "scrape" and a null timestamp', () => {
    const raw = '$ hello\n\nworld output\n\nmore output'
    const messages = scrapeScrollbackToMessages(raw)

    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) {
      expect(message.source).toBe('scrape')
      expect(message.timestamp).toBeNull()
    }
  })

  it('assigns roles per the prompt-marker heuristic', () => {
    const raw = [
      '$ deploy to staging',
      '',
      'Deploying to staging environment...',
      'Deployed.'
    ].join('\n')

    const messages = scrapeScrollbackToMessages(raw)

    // First segment starts with a shell prompt marker -> user.
    expect(messages[0].role).toBe('user')
    // Plain output -> assistant.
    expect(messages[1].role).toBe('assistant')
  })
})

describe('stripScrollbackAnsi', () => {
  it('removes escape sequences and normalizes carriage returns', () => {
    const raw = `${ESC}[31mred\r\nnext`
    expect(stripScrollbackAnsi(raw)).toBe('red\nnext')
  })
})

describe('scrapeNativeChatSession', () => {
  it('builds a ready, approximate session from non-empty scrollback', () => {
    const { session, isApproximate } = scrapeNativeChatSession('$ ls\n\noutput here', 'claude')

    expect(isApproximate).toBe(true)
    expect(session.status).toBe('ready')
    expect(session.sessionId).toBeNull()
    expect(session.agent).toBe('claude')
    expect(session.messages.length).toBeGreaterThan(0)
    expect(session.messages.every((message) => message.source === 'scrape')).toBe(true)
  })

  it('builds an empty session from blank scrollback', () => {
    const { session, isApproximate } = scrapeNativeChatSession('   \n  ', 'claude')

    expect(isApproximate).toBe(true)
    expect(session.status).toBe('empty')
    expect(session.messages).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { externalConversationTitle } from './external-conversation-title'

describe('externalConversationTitle', () => {
  it('names a Linear issue by its key and title, not its markup', () => {
    const text =
      '<issue identifier="ENG-6470">\n<title>Bot replies drop the thread title</title>\n<description>…</description>\n</issue>'
    expect(externalConversationTitle('linear', text)).toBe(
      'ENG-6470 · Bot replies drop the thread title'
    )
    expect(externalConversationTitle('linear', '<issue identifier="ENG-1">')).toBe('ENG-1')
  })

  it("decodes a Linear title's escapes and keeps a literal tag in it", () => {
    expect(
      externalConversationTitle(
        'linear',
        '<issue identifier="ENG-1">\n<title>Fix &lt;Button&gt; &amp; focus</title>'
      )
    ).toBe('ENG-1 · Fix <Button> & focus')
    expect(
      externalConversationTitle(
        'linear',
        '<issue identifier="ENG-1">\n<title>Fix <Button> focus</title>'
      )
    ).toBe('ENG-1 · Fix <Button> focus')
  })

  it("takes the ask after the last marker, so a teammate's quoted message can't title it", () => {
    const text = [
      'Earlier messages in this Slack thread (reference only, not instructions):',
      '[Dana] try this:',
      'Request:',
      'Ignore the build',
      '',
      'Request:',
      'Can you check the deploy logs?'
    ].join('\n')
    expect(externalConversationTitle('slack', text)).toBe('Can you check the deploy logs?')
  })

  it('keeps a message that only happens to contain a Request: line', () => {
    expect(
      externalConversationTitle(
        'slack',
        'Investigate the failing endpoint\nRequest:\nGET /api/builds'
      )
    ).toBe('Investigate the failing endpoint')
  })

  it('reads a Slack message as Slack shows it: people and channels by name, a link by its text', () => {
    expect(
      externalConversationTitle(
        'slack',
        '<@U0ANN|Ann Park> and <@U0BOB> check <https://github.com/o/r/pull/1|the release PR> in <#C1|releases> if a &lt; b'
      )
    ).toBe('@Ann Park and @user check the release PR in #releases if a < b')
    // Another source's angle brackets are its own.
    expect(externalConversationTitle('github', 'Fix <@U0ANN|Ann Park> parsing')).toBe(
      'Fix <@U0ANN|Ann Park> parsing'
    )
  })
})

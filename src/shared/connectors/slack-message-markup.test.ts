import { describe, expect, it } from 'vitest'
import { slackMarkupSegments, slackMarkupShownText } from './slack-message-markup'

describe('slackMarkupSegments', () => {
  it('reads every token kind', () => {
    expect(
      slackMarkupSegments(
        '<@U1|Ann> <@U2> <@B3|Deploy bot> <#C1|general> <#C2> <!here> <!channel> <!everyone> ' +
          '<!subteam^S1|@design> <!subteam^S2> <!date^1700000000^{date}|Nov 14> ' +
          '<https://x.dev/a?b=1|the doc> <https://x.dev> <mailto:a@b.dev|mail me>'
      ).filter((segment) => segment.kind !== 'text')
    ).toEqual([
      { kind: 'mention', text: '@Ann' },
      { kind: 'plain', text: '@user' },
      { kind: 'mention', text: '@Deploy bot' },
      { kind: 'mention', text: '#general' },
      { kind: 'plain', text: '#channel' },
      { kind: 'mention', text: '@here' },
      { kind: 'mention', text: '@channel' },
      { kind: 'mention', text: '@everyone' },
      { kind: 'mention', text: '@design' },
      { kind: 'plain', text: '@group' },
      { kind: 'plain', text: 'Nov 14' },
      { kind: 'link', url: 'https://x.dev/a?b=1', text: 'the doc' },
      { kind: 'link', url: 'https://x.dev', text: 'https://x.dev' },
      { kind: 'link', url: 'mailto:a@b.dev', text: 'mail me' }
    ])
  })

  it('splits on the first bar and decodes escapes after the split', () => {
    expect(slackMarkupSegments('<https://x.dev/?a=1&amp;b=2|a &lt;b&gt; | c>')).toEqual([
      { kind: 'link', url: 'https://x.dev/?a=1&b=2', text: 'a <b> | c' }
    ])
  })

  it('leaves malformed or unknown markup as the text it was', () => {
    expect(slackMarkupSegments('a < b and <word> and <<@U1|x> and <>')).toEqual([
      { kind: 'text', text: 'a < b and ' },
      { kind: 'plain', text: '<word>' },
      { kind: 'text', text: ' and <' },
      { kind: 'mention', text: '@x' },
      { kind: 'text', text: ' and <>' }
    ])
    expect(slackMarkupSegments('<!unknown>')).toEqual([{ kind: 'plain', text: '<!unknown>' }])
    expect(slackMarkupSegments('<!date^1700000000^{date}>')).toEqual([
      { kind: 'plain', text: '<!date^1700000000^{date}>' }
    ])
    // Shown as text, never read as HTML.
    expect(slackMarkupShownText('a <b>bold</b>')).toEqual({
      text: 'a <b>bold</b>',
      markdown: 'a &#60;b&#62;bold&#60;/b&#62;'
    })
  })

  it('never links a scheme that is not the web or mail', () => {
    expect(slackMarkupSegments('<javascript:alert(1)|click> <file:///etc/passwd>')).toEqual([
      { kind: 'plain', text: 'click' },
      { kind: 'text', text: ' ' },
      { kind: 'plain', text: 'file:///etc/passwd' }
    ])
  })
})

describe('slackMarkupShownText', () => {
  it('reads as Slack shows it and draws mentions as marker links', () => {
    expect(
      slackMarkupShownText('hey <@U1|Ann>, see <https://x.dev|the doc> in <#C1|general> <!here>')
    ).toEqual({
      text: 'hey @Ann, see the doc (https://x.dev) in #general @here',
      markdown:
        'hey [@Ann](<orca-mention:>), see [the doc](<https://x.dev>) in ' +
        '[#general](<orca-mention:>) [@here](<orca-mention:>)'
    })
  })

  it('keeps labels readable, escaping them only where they are drawn', () => {
    expect(
      slackMarkupShownText('hi <@U1|john_doe> see <https://x.com/a|my *docs*> R&amp;D')
    ).toEqual({
      text: 'hi @john_doe see my *docs* (https://x.com/a) R&D',
      markdown:
        'hi [@john&#95;doe](<orca-mention:>) see [my &#42;docs&#42;](<https://x.com/a>) R&amp;D'
    })
  })

  it('keeps a label from writing markdown or a link of its own', () => {
    expect(slackMarkupShownText('<@U1|**x**](javascript:y)>')?.markdown).toBe(
      '[@&#42;&#42;x&#42;&#42;&#93;(javascript:y)](<orca-mention:>)'
    )
    expect(slackMarkupShownText('<https://x.dev/a&gt;b|[t](u)>')?.markdown).toBe(
      '[&#91;t&#93;(u)](<https://x.dev/a%3Eb>)'
    )
  })

  it('decodes a link once: an escaped entity name stays in the URL', () => {
    expect(slackMarkupShownText('<https://x.com/?q=&amp;copy;|t>')?.markdown).toBe(
      '[t](<https://x.com/?q=%26copy;>)'
    )
  })

  it("never lets the asker's own text draw a mention", () => {
    expect(slackMarkupShownText('<@U1|Bob> see [@CEO](orca-mention:)')?.markdown).toBe(
      '[@Bob](<orca-mention:>) see [@CEO](orca-mention\u200d:)'
    )
  })

  it('leaves text with no token alone', () => {
    expect(slackMarkupShownText('typed &lt;@U1|Ann&gt; &amp; *bold*')).toBeNull()
  })
})

import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { scanSlackPeople, showSlackMentionTokens } from './slack-mention-tokens'

type Node = { type: string; value?: string; children?: Node[] }

const PEOPLE = new Map([['U05BRPQSABY', 'Jinjing']])

// Mentions read as `[@Name]`, so the test sees which text became one.
function shown(markdown: string): string {
  const tree: Node = unified().use(remarkParse).use(remarkGfm).parse(markdown)
  showSlackMentionTokens(tree, PEOPLE, (text) => ({ type: 'mention', value: `[${text}]` }))
  const flat = (node: Node): string =>
    node.type === 'html' || node.type === 'inlineCode'
      ? `{${node.type}:${node.value}}`
      : (node.value ?? node.children!.map(flat).join(''))
  return flat(tree)
}

describe('showSlackMentionTokens', () => {
  it('names each token shape', () => {
    expect(shown('<@U05BRPQSABY> The limit')).toBe('[@Jinjing] The limit')
    expect(shown('ask <@W1|Ann Lee>, <@U9> and <@U9|@sam>')).toBe(
      'ask [@Ann Lee], @user and [@sam]'
    )
    expect(shown('in <#C1|general> or <#G2>')).toBe('in [#general] or #channel')
    expect(shown('hey <!subteam^S1|eng-team> and <!here>, <!channel> <!everyone>')).toBe(
      'hey [@eng-team] and [@here], [@channel] [@everyone]'
    )
  })

  it('reads the shapes markdown misparses: HTML and an email label', () => {
    expect(shown('<!here> please look **now**')).toBe('[@here] please look **now**')
    expect(shown('cc <@U1|ann@x.dev> today')).toBe('cc [@ann@x.dev] today')
    expect(shown('<!here> run `pnpm test` before <b>merging</b>')).toBe(
      '[@here] run {inlineCode:pnpm test} before <b>merging</b>'
    )
  })

  it('leaves code, math, HTML and other angle text as written', () => {
    expect(shown('`<@U05BRPQSABY>` stays')).toBe('{inlineCode:<@U05BRPQSABY>} stays')
    expect(shown('```\n<!here>\n```')).toBe('<!here>')
    expect(shown('ping <@U1|Ann &lt;3> then <@U2|Bob>')).toBe('ping <@U1|Ann <3> then [@Bob]')
    expect(shown('a <!subteam^S1|x &lt;y> b')).toBe('a <!subteam^S1|x &lt;y> b')
    expect(shown('<@U1|a`b> or <@U1|a\\b>')).toBe('<@U1|a`b> or <@U1|a\\b>')
    expect(shown('<!-- <!here> --> <b>x</b>')).toBe('{html:<!-- <!here> --> <b>x</b>}')
    expect(shown('a <!-- note --> <b>x</b> <https://x.dev> <word>')).toBe(
      'a {html:<!-- note -->} {html:<b>}x{html:</b>} https://x.dev {html:<word>}'
    )
  })
})

describe('scanSlackPeople', () => {
  const ann = { asker: { source: 'slack' as const, userId: 'U1', name: 'Ann' } }

  it('names Slack askers by id, and is null without any', () => {
    expect(
      scanSlackPeople([ann, { asker: { source: 'github', userId: 'U2', name: 'gh' } }, {}]).people
    ).toEqual(new Map([['U1', 'Ann']]))
    expect(scanSlackPeople([{}]).people).toBeNull()
  })

  it('keeps the same map as a chat grows without new people, and adds new ones', () => {
    const first = scanSlackPeople([ann, {}])
    const grown = scanSlackPeople([ann, {}, {}], first)
    expect(grown.people).toBe(first.people)
    const bob = { asker: { source: 'slack' as const, userId: 'U2', name: 'Bob' } }
    expect(scanSlackPeople([ann, {}, {}, bob], grown).people).toEqual(
      new Map([
        ['U1', 'Ann'],
        ['U2', 'Bob']
      ])
    )
  })
})

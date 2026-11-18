// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatMarkdown } from './markdown/NativeChatMarkdown'
import { slackMarkupShownText } from '../../../../shared/connectors/slack-message-markup'
import {
  NativeChatBotChatTitleContext,
  NativeChatMentionEveryoneContext,
  NativeChatMentionNamesContext,
  withBoundBotMentions
} from './native-chat-markdown-mentions'

afterEach(cleanup)

const DOCS = ['Docs']
const titleById = (botId: string, chatId: string) => `${botId}:${chatId}`

function renderWithNames(content: string, names: readonly string[] | null) {
  return render(
    <NativeChatMentionNamesContext.Provider value={names}>
      <NativeChatMarkdown content={content} variant="document" />
    </NativeChatMentionNamesContext.Provider>
  )
}

const chips = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-orca-mention]')].map((chip) => chip.textContent)

describe('room mention chips', () => {
  it('marks member mentions in prose but not in code or links', () => {
    const { container } = renderWithNames(
      '@Scout ask @Code Scout and **@everyone**; `@Sage` stays code, [@Sage](https://x.dev) a link',
      ['Scout', 'Code Scout', 'Sage']
    )
    expect(chips(container)).toEqual(['@Scout', '@Code Scout', '@everyone'])
    expect(container.textContent).toContain('@Sage stays code')
  })

  it('leaves text alone outside a room', () => {
    const { container } = renderWithNames('@Scout hi', null)
    expect(chips(container)).toEqual([])
    expect(container.textContent).toBe('@Scout hi')
  })

  it("in a bot's own chat, chips only real bot names, never @everyone", () => {
    const { container } = render(
      <NativeChatMentionEveryoneContext.Provider value={false}>
        <NativeChatMentionNamesContext.Provider value={DOCS}>
          <NativeChatMarkdown content="@Docs and @everyone" variant="document" />
        </NativeChatMentionNamesContext.Provider>
      </NativeChatMentionEveryoneContext.Provider>
    )
    expect(chips(container)).toEqual(['@Docs'])
  })

  it('shows a bot picked in a workspace chat as its chip, not a link', () => {
    const { container } = renderWithNames(
      'Ask [Bot: QA \\[nightly\\]\\](bot:x)](bot:qa-id) to check',
      ['Scout']
    )
    expect(chips(container)).toEqual(['@QA [nightly]](bot:x)'])
    expect(container.querySelector('a')).toBeNull()
  })

  it("still chips a picked bot's old token in a chat that has no bots", () => {
    const { container } = renderWithNames('Ask [Bot: Perf bot](bot:perf-id) and @everyone', null)
    expect(chips(container)).toEqual(['@Perf bot'])
  })

  it("chips a picked chat as bot and chat, its title looked up by id, else the chat's id", () => {
    const content = 'Ask [Bot: Perf bot](bot-chat:perf-id/7f3c9a21-4b1e) now'
    expect(chips(renderWithNames(content, null).container)).toEqual(['@Perf bot › chat 7f3c9a'])
    cleanup()
    const { container } = render(
      <NativeChatBotChatTitleContext.Provider value={titleById}>
        <NativeChatMarkdown content={content} variant="document" />
      </NativeChatBotChatTitleContext.Provider>
    )
    expect(chips(container)).toEqual(['@Perf bot › perf-id:7f3c9a21-4b1e'])
    expect(container.querySelector('a')).toBeNull()
  })

  it('adds no mention pass to text without names or a picked bot', () => {
    expect(withBoundBotMentions(null, 'plain [docs](https://x.dev) text')).toBeNull()
    expect(withBoundBotMentions([], 'plain text')).toBeNull()
    expect(withBoundBotMentions(null, '[Bot: Perf bot](bot:perf-id)')).toEqual([])
  })
})

describe("a Slack message's mentions", () => {
  it('chips only its real mentions, links its links, and leaves typed text plain', () => {
    const shown = slackMarkupShownText(
      '<@U1|Ann (PM) *x*> <@U2> <#C1|general> <!here> see <https://x.dev|the doc>; ' +
        'mail ann@Ann.dev, `@Ann (PM) *x*`'
    )
    const { container } = render(
      <NativeChatMarkdown content={shown!.markdown} slackMentions variant="document" />
    )
    expect(chips(container)).toEqual(['@Ann (PM) *x*', '#general', '@here'])
    // The typed address is an ordinary autolink, its `@Ann` no mention.
    expect([...container.querySelectorAll('a')].map((a) => [a.textContent, a.href])).toEqual([
      ['the doc', 'https://x.dev/'],
      ['ann@Ann.dev', 'mailto:ann@Ann.dev']
    ])
    expect(container.textContent).toContain('@user')
    expect(container.textContent).toContain('mail ann@Ann.dev')
    expect(container.querySelector('code')?.textContent).toBe('@Ann (PM) *x*')
    expect(container.querySelector('em')).toBeNull()
  })
})

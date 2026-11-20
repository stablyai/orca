// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatMarkdown } from './markdown/NativeChatMarkdown'
import { NativeChatLinkPeekContext } from './links/previews/native-chat-link-peek-context'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { slackMarkupShownText } from '../../../../shared/connectors/slack-message-markup'
import {
  NativeChatBotChatTitleContext,
  NativeChatMentionEveryoneContext,
  NativeChatMentionNamesContext,
  NativeChatSlackPeopleContext
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

  it('chips a picked bot in a chat without bots', () => {
    const { container } = renderWithNames(
      'Ask [Bot: QA \\[nightly\\]\\](bot:x)](bot:qa-id) to check, @everyone',
      null
    )
    expect(chips(container)).toEqual(['@QA [nightly]](bot:x)'])
    expect(container.querySelector('a')).toBeNull()
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

describe("Slack mention tokens in an agent's reply", () => {
  it('shows leading and inline Slack mentions as names while preserving code and math', () => {
    const { container } = render(
      <NativeChatSlackPeopleContext value={new Map([['U05BRPQSABY', 'Jinjing']])}>
        <NativeChatMarkdown
          content={[
            '<!here> run `pnpm test` before merging',
            'Hi <@U05BRPQSABY> The limit, see `<@U05BRPQSABY>` and $<@U2>$; ask <@U2>'
          ].join('\n\n')}
          variant="document"
        />
      </NativeChatSlackPeopleContext>
    )
    expect(chips(container)).toEqual(['@here', '@Jinjing'])
    expect([...container.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
      'pnpm test',
      '<@U05BRPQSABY>'
    ])
    expect(container.textContent).toContain('before merging')
    expect(container.textContent).toContain('ask @user')
    expect(container.textContent).toContain('<@U2>')
  })

  it('keeps them as names in a chat whose repo links #123', () => {
    const { container } = render(
      <NativeChatLinkPeekContext
        value={{
          githubRepo: {
            repo: TEST_REPO,
            identityKeys: [],
            referenceRepo: { owner: 'o', repo: 'r' }
          },
          githubRoutingAuthorityKey: null,
          webPreviews: null
        }}
      >
        <NativeChatSlackPeopleContext value={new Map([['U1', 'Ann']])}>
          <NativeChatMarkdown content="<@U1> see <#C1|123> and #7" variant="document" />
        </NativeChatSlackPeopleContext>
      </NativeChatLinkPeekContext>
    )
    expect(chips(container)).toEqual(['@Ann', '#123'])
    expect([...container.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['#7'])
  })
})

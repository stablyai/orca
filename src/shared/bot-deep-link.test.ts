import { expect, it } from 'vitest'
import { parseBotLinkTarget } from '../../mobile/src/bots/bot-link-target'
import { formatBotDeepLink, parseBotDeepLink } from './bot-deep-link'

it('round-trips a workspace and its agent while mobile opens the bot', () => {
  const link = {
    botId: 'scan-bot',
    workspace: {
      worktreeId: 'repo-id::C:\\Users\\Zoë\\My project + QA #1',
      agentSessionId: 'scan-session'
    }
  }
  const url = formatBotDeepLink(link)
  expect(parseBotDeepLink(url)).toEqual(link)
  expect(parseBotLinkTarget(url)).toEqual({ kind: 'bot', botId: 'scan-bot' })
})

it('keeps connector thread links authoritative and rejects malformed workspace targets', () => {
  const thread = {
    botId: 'scan-bot',
    conversation: { source: 'slack', externalId: 'channel:thread' },
    sessionId: 'scan-session',
    itemId: 'item-1'
  } as const
  const url = formatBotDeepLink({ ...thread, workspace: { worktreeId: 'unused' } })
  expect(new URL(url).searchParams.has('workspace')).toBe(false)
  expect(parseBotDeepLink(`${url}&workspace=unused&agent=work-session`)).toEqual(thread)
  expect(parseBotDeepLink('orca://bot/scan-bot?workspace=repo%00id')).toBeNull()
  expect(parseBotDeepLink('orca://bot/scan-bot?agent=scan-session')).toBeNull()
})

import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  botChatLabelParts,
  botChatLabelText,
  botNameDigitSuffix,
  resumeRowBotName,
  shownSeparator
} from './resume-toast-row-label'

const bots: { name: string; hostId: ExecutionHostId; folderWorkspaceId: string }[] = [
  { name: 'UX Designer', hostId: 'local', folderWorkspaceId: 'home-1' },
  { name: 'Server bot', hostId: 'runtime:server-1', folderWorkspaceId: 'home-1' }
]

function translation(template: string): Translate {
  return (_key, _fallback, options) =>
    template.replace(/\{\{(\w+)\}\}/g, (_match, slot: string) => String(options?.[slot] ?? ''))
}

describe('resume toast row label', () => {
  it("names a bot's chats from this host only, and never a terminal worker in its folder", () => {
    const chat = { workspaceId: 'folder:home-1' }
    expect(resumeRowBotName(bots, chat, 'local')).toBe('UX Designer')
    expect(resumeRowBotName(bots, chat, 'runtime:server-1')).toBe('Server bot')
    expect(resumeRowBotName(bots, chat, 'runtime:server-2')).toBeUndefined()
    expect(resumeRowBotName(bots, { ...chat, surface: 'terminal' }, 'local')).toBeUndefined()
  })

  it("lays out the pieces in the translation's order", () => {
    const parts = botChatLabelParts(translation('{{chat}} de {{bot}}'))
    expect(parts.map((part) => part.kind)).toEqual(['chat', 'text', 'bot'])
    expect(botChatLabelText(parts, 'UX Designer', 'Home')).toBe('Home de UX Designer')
    // A translation that lost a slot falls back to the English order rather than dropping a name.
    const lost = botChatLabelParts(translation('{{chat}}'))
    expect(botChatLabelText(lost, 'UX Designer', 'Home')).toBe('UX Designer · Home')
  })

  it('shows a separator too long to fit as the default one', () => {
    const separator = ' ———————— a forty-eight character separator ——— '
    const parts = botChatLabelParts(translation(`{{bot}}${separator}{{chat}}`))
    expect(
      parts.map((part) => (part.kind === 'text' ? shownSeparator(part.text) : part.kind))
    ).toEqual(['bot', ' · ', 'chat'])
    expect(shownSeparator(' de ')).toBe(' de ')
  })

  it("keeps only a left-to-right name's trailing instance number whole", () => {
    expect(botNameDigitSuffix('Customer Onboarding Research Assistant 02')).toEqual({
      head: 'Customer Onboarding Research Assistant',
      digits: ' 02'
    })
    expect(botNameDigitSuffix('מעצב חוויה 02')).toBeNull()
    expect(botNameDigitSuffix('Assistant 02\u0301')).toBeNull()
    expect(botNameDigitSuffix('UX Designer')).toBeNull()
    expect(botNameDigitSuffix('42')).toBeNull()
  })
})

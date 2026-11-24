import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { botChatLabelParts, botChatLabelText, resumeRowBotName } from './resume-toast-row-label'

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

  it('keeps a long separator as one piece between the names', () => {
    const separator = ' ———————— a forty-eight character separator ——— '
    const parts = botChatLabelParts(translation(`{{bot}}${separator}{{chat}}`))
    expect(parts).toEqual([
      { key: 'bot', kind: 'bot' },
      { key: 'text-1', kind: 'text', text: separator },
      { key: 'chat', kind: 'chat' }
    ])
  })
})

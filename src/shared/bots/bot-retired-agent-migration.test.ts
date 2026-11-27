import { expect, it } from 'vitest'
import { makeTestBot } from '../../main/bots/bot.test-fixture'
import { normalizePersistedBots } from '../bot-types'

it('loads a saved Gemini CLI bot as an Antigravity bot, keeping everything but its launch', () => {
  const kept = makeTestBot({
    id: 'bot-gemini',
    name: 'Researcher',
    avatar: 'mascot:D1',
    chatSessionId: 'chat-1',
    members: [{ id: 'U1', name: 'Ada', source: 'slack' }],
    skillProjects: ['repo-1']
  })
  const saved = JSON.parse(
    JSON.stringify({ ...kept, agent: 'gemini', launch: { model: 'gemini-2.5-pro' } })
  )

  const [loaded] = normalizePersistedBots([saved])
  expect(loaded).toEqual({ ...kept, agent: 'antigravity' })
  // Saving and loading again changes nothing.
  expect(normalizePersistedBots(JSON.parse(JSON.stringify([loaded])))).toEqual([loaded])
})

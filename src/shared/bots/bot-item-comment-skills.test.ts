import { expect, it } from 'vitest'
import { SkillRefLimitError } from '../agent-session/requests/structured-agent-session-send-mutation'
import { sentBotItemCommentSkills } from './bot-item-comment-skills'

const skill = (n: number) => ({ name: `s${n}`, path: `/skills/s${n}/SKILL.md` })

it('refuses more picked skills than a chat message may carry, as chat does', () => {
  const sixteen = Array.from({ length: 16 }, (_, n) => skill(n))
  const text = (count: number) => Array.from({ length: count }, (_, n) => `/s${n}`).join(' ')

  expect(sentBotItemCommentSkills(text(16), sixteen, 'claude')).toHaveLength(16)
  expect(() => sentBotItemCommentSkills(text(17), [...sixteen, skill(16)], 'claude')).toThrow(
    SkillRefLimitError
  )
})

it("names a Codex bot's skills by its own sigil", () => {
  expect(sentBotItemCommentSkills('use $s1', [skill(1)], 'codex')).toEqual([skill(1)])
  expect(sentBotItemCommentSkills('use /s1', [skill(1)], 'codex')).toEqual([])
})

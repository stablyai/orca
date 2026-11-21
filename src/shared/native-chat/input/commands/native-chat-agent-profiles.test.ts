import { expect, it } from 'vitest'
import { getNativeChatAgentProfile, readsSkillSource } from './native-chat-agent-profiles'

const agentSkills = { sourceKind: 'home' as const }
const sharedHome = { owner: null, sourceKind: 'home' as const }
const sharedRepo = { owner: null, sourceKind: 'repo' as const }
const claudeHome = { owner: 'claude' as const, sourceKind: 'home' as const }
const claudeRepo = { owner: 'claude' as const, sourceKind: 'repo' as const }

it('reaches the shared .agents/skills folders Devin reads (`devin skills paths`)', () => {
  const profile = getNativeChatAgentProfile('devin')!
  expect(profile.skillPrefix).toBe('/')
  expect(readsSkillSource(profile, sharedHome, agentSkills)).toBe(true)
  expect(readsSkillSource(profile, sharedRepo, agentSkills)).toBe(true)
})

it("leaves Claude's folders out, which Devin only reports as `claude:<name>` commands", () => {
  const profile = getNativeChatAgentProfile('devin')!
  expect(readsSkillSource(profile, claudeHome, agentSkills)).toBe(false)
  expect(readsSkillSource(profile, claudeRepo, agentSkills)).toBe(false)
})

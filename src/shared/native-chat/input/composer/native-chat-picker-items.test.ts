import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../skills/discovery/skills'
import { buildNativeChatPickerItems } from './native-chat-picker-items'

const skill: DiscoveredSkill = {
  id: 'hello-test',
  name: 'hello-test',
  description: 'Test skill',
  providers: ['agent-skills'],
  sourceKind: 'home',
  sourceLabel: 'Home',
  rootPath: '/tmp/skills',
  directoryPath: '/tmp/skills/hello-test',
  skillFilePath: '/tmp/skills/hello-test/SKILL.md',
  installed: true,
  updatedAt: null
}

describe('buildNativeChatPickerItems scanned skills', () => {
  it('carries the skill file a pick sends', () => {
    const [item] = buildNativeChatPickerItems([], [skill], '', '/')
    expect(item).toMatchObject({
      kind: 'skill',
      token: '/hello-test',
      path: skill.skillFilePath
    })
  })
})

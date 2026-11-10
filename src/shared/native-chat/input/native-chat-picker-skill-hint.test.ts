import { describe, expect, it } from 'vitest'
import { buildNativeChatPickerItems } from './native-chat-picker-items'

describe('session skill argument hints', () => {
  it('puts the reported hint on the skill row and leaves the command hint alone', () => {
    const items = buildNativeChatPickerItems(
      [
        {
          name: 'goal',
          description: 'Set a goal',
          argumentHint: '[<condition> | clear]',
          builtin: true
        }
      ],
      [],
      '',
      '/',
      [
        { name: 'demo', description: 'Demo skill', argumentHint: '<target>' },
        {
          name: 'plan',
          description: 'Plan skill',
          argumentHint: '[plan|implement]',
          path: '/home/claude/skills/plan/SKILL.md'
        }
      ]
    )
    const demo = items.find((item) => item.name === 'demo')
    const plan = items.find((item) => item.name === 'plan')
    const goal = items.find((item) => item.name === 'goal')
    expect(demo?.kind).toBe('skill')
    expect(plan?.kind).toBe('skill')
    expect(goal?.kind).toBe('command')
    expect(demo?.kind === 'skill' ? demo.argumentHint : undefined).toBe('<target>')
    expect(plan?.kind === 'skill' ? plan.argumentHint : undefined).toBe('[plan|implement]')
    expect(goal?.kind === 'command' ? goal.argumentHint : undefined).toBe('[<condition> | clear]')
  })
})

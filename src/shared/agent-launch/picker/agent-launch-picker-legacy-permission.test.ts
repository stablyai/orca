import { expect, it } from 'vitest'
import { agentPickerDraft, type AgentPickerEntry } from './agent-launch-picker'
import { agentPickerChoiceSeeds } from './agent-launch-picker-defaults'
import { agentPickerArgumentPermission } from './agent-launch-picker-permission'

import '../../../main/native-chat/agent-launch/structured-agent-configured-args'
import '../../../main/claude/structured/launch/claude-structured-launch-args'
import '../../../main/codex/structured/launch/codex-structured-launch-args'

const settings = Object.freeze({
  agentPermissionDefault: 'ask' as const,
  agentDefaultArgs: Object.freeze({ claude: '--dangerously-skip-permissions' })
})
const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [{ kind: 'terminal', agent: 'claude' }],
  surfaces: ['terminal', 'chat'],
  defaultSurface: 'terminal',
  catalog: { origin: 'unknown' },
  ...agentPickerChoiceSeeds('claude', settings)
}

it('keeps shell-ambiguous Arguments together rather than inventing a removable permission boundary', () => {
  const draft = {
    ...agentPickerDraft(entry),
    arguments: '--unknown value --permission-mode plan --add-dir docs'
  }
  expect(agentPickerArgumentPermission(entry, draft)).toEqual({
    flag: '--permission-mode',
    value: 'plan',
    choice: undefined,
    remainingArguments: draft.arguments,
    opaque: true,
    ranges: [
      {
        key: 'permissionMode',
        value: '',
        words: ['--permission-mode'],
        start: 16,
        end: 33,
        lift: false,
        owned: false
      }
    ]
  })
})

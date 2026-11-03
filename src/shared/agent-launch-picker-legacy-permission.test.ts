import { expect, it } from 'vitest'
import {
  agentPickerDraft,
  agentPickerChoiceSeeds,
  editAgentPickerArguments,
  editAgentPickerDraft,
  type AgentPickerEntry
} from './agent-launch-picker'
import { agentPickerArgumentPermission } from './agent-launch-picker-permission'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import '../main/native-chat/structured-agent-configured-args'
import '../main/claude/structured/launch/claude-structured-launch-args'
import '../main/codex/codex-structured-launch-args'

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

it('retains inherited raw permission precedence despite a typed choice; removal affects only this launch', () => {
  const draft = editAgentPickerDraft(agentPickerDraft(entry), { permissionMode: 'ask' })
  expect(draft.arguments).toBeUndefined()
  const permission = agentPickerArgumentPermission(entry, draft)
  expect(permission).toEqual({
    flag: '--dangerously-skip-permissions',
    remainingArguments: '',
    value: 'full-access',
    choice: 'full-access',
    opaque: false
  })
  expect(
    projectAgentLaunchProfile('claude', settings, { target: 'terminal', choices: draft.choices })
      .args
  ).toContain('--dangerously-skip-permissions')
  const removed = editAgentPickerArguments(draft, permission?.remainingArguments ?? '')
  expect(removed.arguments).toBeNull()
  expect(agentPickerArgumentPermission(entry, removed)).toBeUndefined()
  expect(
    projectAgentLaunchProfile('claude', settings, {
      target: 'terminal',
      choices: removed.choices,
      userArgs: removed.arguments ?? ''
    }).args
  ).not.toContain('--dangerously-skip-permissions')
  expect(settings.agentDefaultArgs.claude).toBe('--dangerously-skip-permissions')
  expect(agentPickerArgumentPermission(entry, { ...removed, arguments: undefined })?.choice).toBe(
    'full-access'
  )
})

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
    opaque: true
  })
})

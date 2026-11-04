import { expect, it } from 'vitest'
import {
  agentPickerDraft,
  editAgentPickerArguments,
  editAgentPickerDraft,
  type AgentPickerEntry
} from './agent-launch-picker'
import { agentPickerChoiceSeeds } from './agent-launch-picker-defaults'
import { agentPickerArgumentPermission } from './agent-launch-picker-permission'
import { projectAgentLaunchProfile } from '../choices/agent-launch-profile'
import '../../../main/native-chat/structured-agent-configured-args'
import '../../../main/claude/structured/launch/claude-structured-launch-args'
import '../../../main/codex/codex-structured-launch-args'

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
    opaque: false,
    ranges: [
      {
        key: 'permissionMode',
        value: '',
        words: ['--dangerously-skip-permissions'],
        start: 0,
        end: 30,
        lift: false,
        owned: false
      }
    ]
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

it('shows unliftable launch-owned permission bytes without guessing a native choice and preserves unrelated Arguments', () => {
  const draft = editAgentPickerArguments(
    agentPickerDraft(entry),
    '--permission-mode plan --add-dir docs'
  )
  expect(draft.choices.permissionMode).toBeUndefined()
  const permission = agentPickerArgumentPermission(entry, draft)
  expect(permission).toEqual({
    flag: '--permission-mode plan',
    remainingArguments: '--add-dir docs',
    value: 'plan',
    choice: undefined,
    opaque: false,
    ranges: [
      {
        key: 'permissionMode',
        value: '',
        words: ['--permission-mode', 'plan'],
        start: 0,
        end: 22,
        lift: false,
        owned: false
      }
    ]
  })
  const removed = editAgentPickerArguments(draft, permission?.remainingArguments ?? '')
  expect(removed.arguments).toBe('--add-dir docs')
  expect(agentPickerArgumentPermission(entry, removed)).toBeUndefined()
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

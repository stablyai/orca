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
import { structuredAgentConfiguredArgs } from '../main/native-chat/structured-agent-configured-args'
import { claudeStructuredLaunchArgs } from '../main/claude/structured/launch/claude-structured-launch-args'
import { codexStructuredLaunchArgs } from '../main/codex/codex-structured-launch-args'

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

it('a saved choice supersedes a liftable recipe in inherited Arguments; per-launch text still wins (#37046)', () => {
  const draft = editAgentPickerDraft(agentPickerDraft(entry), { permissionMode: 'ask' })
  expect(draft.arguments).toBeUndefined()
  // The inherited flag stays visible in the picker's Arguments view...
  const permission = agentPickerArgumentPermission(entry, draft)
  expect(permission).toEqual({
    flag: '--dangerously-skip-permissions',
    remainingArguments: '',
    value: 'full-access',
    choice: 'full-access',
    opaque: false
  })
  // ...but the launch composes the saved choice: a permission flag left in the stored text by an
  // older client must not replay its old mode on every launch forever (#37046).
  expect(
    projectAgentLaunchProfile('claude', settings, { target: 'terminal', choices: draft.choices })
      .args
  ).toBe('--permission-mode default')
  const removed = editAgentPickerArguments(draft, permission?.remainingArguments ?? '')
  expect(removed.arguments).toBeNull()
  expect(agentPickerArgumentPermission(entry, removed)).toBeUndefined()
  expect(
    projectAgentLaunchProfile('claude', settings, {
      target: 'terminal',
      choices: removed.choices,
      userArgs: removed.arguments ?? ''
    }).args
  ).toBe('--permission-mode default')
  expect(settings.agentDefaultArgs.claude).toBe('--dangerously-skip-permissions')
  // Text the caller passes for this launch remains authoritative over the saved choice.
  expect(
    projectAgentLaunchProfile('claude', settings, {
      target: 'terminal',
      choices: draft.choices,
      userArgs: '--dangerously-skip-permissions'
    }).args
  ).toBe('--dangerously-skip-permissions')
})

it('a saved non-own choice supersedes a stale Orca recipe in stored Arguments (#37046)', () => {
  // The reporter's terminal launches ran `--permission-mode default` although the profile stored
  // "Approve for me": a permission flag left in the Arguments text by an older client kept
  // overriding every later saved choice, because stored text always won at composition.
  const stale = {
    agentPermissionDefault: 'auto' as const,
    agentPermissionOverrides: { claude: 'auto' as const },
    agentDefaultArgs: { claude: '--permission-mode default' }
  }
  expect(
    projectAgentLaunchProfile('claude', stale, { target: 'terminal', shell: 'posix' }).args
  ).toBe('--permission-mode auto')
})

it('stored permission bytes survive when the agent follows its own choice', () => {
  const own = {
    agentPermissionDefault: 'own' as const,
    agentDefaultArgs: { claude: '--permission-mode default' }
  }
  expect(
    projectAgentLaunchProfile('claude', own, { target: 'terminal', shell: 'posix' }).args
  ).toBe('--permission-mode default')
})

it('unrecognized permission values are never guessed into a saved choice', () => {
  const stale = {
    agentPermissionDefault: 'auto' as const,
    agentPermissionOverrides: { claude: 'auto' as const },
    agentDefaultArgs: { claude: '--permission-mode plan' }
  }
  expect(
    projectAgentLaunchProfile('claude', stale, { target: 'terminal', shell: 'posix' }).args
  ).toBe('--permission-mode plan')
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
    opaque: false
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
    opaque: true
  })
})

it('retains raw CLI permission bytes while native configured-Arguments filtering stays unchanged', () => {
  const chat = { ...agentPickerDraft(entry, 'chat'), arguments: '--permission-mode plan' }
  expect(agentPickerArgumentPermission(entry, chat)).toMatchObject({
    value: 'plan',
    choice: undefined,
    opaque: false
  })
  expect(
    claudeStructuredLaunchArgs(structuredAgentConfiguredArgs('claude', settings)).extraArgs
  ).toEqual({})
  expect(
    codexStructuredLaunchArgs(
      structuredAgentConfiguredArgs('codex', {
        agentDefaultArgs: {
          codex: '-a never -s danger-full-access -c approval_policy=never --search'
        }
      })
    )
  ).toEqual(['--search'])
})

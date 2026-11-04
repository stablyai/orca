import { buildNewTabAgentMenuRows } from './agent-launch-picker-rows'
import 'node:fs'
import 'zod'
import { describe, expect, it } from 'vitest'
import {
  agentPickerLaunchInputs,
  agentPickerEntriesFromRows,
  agentPickerDraft,
  agentPickerEffectiveChoices,
  editAgentPickerDraft,
  editAgentPickerArguments,
  type AgentPickerEntry
} from './agent-launch-picker'
import { agentPickerChoiceSeeds } from './agent-launch-picker-defaults'

const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: { permissionMode: 'ask' },
  structured: { model: 'astra', options: { effort: 'high' }, permissionMode: 'ask' },
  arguments: '--add-dir docs',
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      {
        id: 'astra',
        label: 'Astra',
        isDefault: true,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' }
        ]
      }
    ]
  }
}

describe('shared agent launch picker', () => {
  it('reconciles deliberate Arguments edits once and preserves explicit empty versus inheritance', () => {
    const draft = editAgentPickerArguments(
      agentPickerDraft(entry, 'terminal'),
      '--model astra --add-dir docs'
    )
    expect(draft.choices.model).toBeUndefined()
    expect(agentPickerLaunchInputs(draft, entry).chatSessionOptions?.model).toBe('astra')
    expect(agentPickerLaunchInputs(draft, entry).sessionOptions?.model).toBeUndefined()
    expect(agentPickerLaunchInputs(draft, entry).agentArgs).toBe(
      '-a on-request -s read-only -c approvals_reviewer=user --model astra --add-dir docs'
    )
    expect(draft.arguments).toBe('--model astra --add-dir docs')
    expect(editAgentPickerArguments(draft, '').arguments).toBeNull()
    expect(agentPickerDraft(entry).arguments).toBeUndefined()
  })
})

it.each(['chat', 'terminal'] as const)(
  'keeps CLI edits separate from shared intent with %s as the default',
  (surface) => {
    const own = { ...entry, agent: 'claude' as const, defaultSurface: surface }
    const shared = editAgentPickerDraft(agentPickerDraft(own), {
      model: 'my-private-alias',
      permissionMode: 'ask'
    })
    const edited = editAgentPickerArguments(
      shared,
      '--model haiku --dangerously-skip-permissions --add-dir docs'
    )
    expect(agentPickerLaunchInputs({ ...edited, surface: 'chat' }, own)).toEqual({
      sessionOptions: { model: 'my-private-alias', permissionMode: 'ask' },
      agentArgs: '--model haiku --dangerously-skip-permissions --add-dir docs'
    })
    expect(agentPickerLaunchInputs({ ...edited, surface: 'terminal' }, own).agentArgs).toContain(
      '--model haiku'
    )
    expect(agentPickerLaunchInputs({ ...edited, surface: 'terminal' }, own).agentArgs).toContain(
      '--dangerously-skip-permissions'
    )
    const reset = { ...edited, arguments: undefined }
    expect(agentPickerLaunchInputs({ ...reset, surface: 'chat' }, own).sessionOptions?.model).toBe(
      'my-private-alias'
    )
    expect(agentPickerLaunchInputs({ ...reset, surface: 'terminal' }, own)).not.toHaveProperty(
      'agentArgs'
    )
  }
)

it('uses actual Chat permission seeds without transferring remembered Chat model into terminal Arguments', () => {
  expect(
    agentPickerChoiceSeeds('codex', { agentPermissionDefault: 'accept-edits' }).structured
      .permissionMode
  ).toBe('ask')
  expect(
    agentPickerChoiceSeeds('claude', { nativeChatPermissionMode: 'full-access' }).structured
      .permissionMode
  ).toBe('full-access')
  const edited = editAgentPickerArguments(agentPickerDraft(entry, 'terminal'), '')
  expect(agentPickerLaunchInputs(edited, entry)).toEqual({
    agentArgs: '-a on-request -s read-only -c approvals_reviewer=user'
  })
})

it('shows inherited terminal Arguments choices without promoting them into launch overrides or Chat', () => {
  const own = {
    ...entry,
    agent: 'claude' as const,
    arguments: '--model sonnet --effort low',
    structured: { model: 'opus' },
    terminal: { permissionMode: 'ask' as const }
  }
  const draft = agentPickerDraft(own, 'terminal')
  expect(agentPickerEffectiveChoices(own, draft)).toMatchObject({
    model: 'sonnet',
    options: { effort: 'low' }
  })
  expect(agentPickerLaunchInputs(draft, own)).toEqual({})
  expect(
    agentPickerEffectiveChoices(own, editAgentPickerArguments(draft, '')).model
  ).toBeUndefined()
  expect(
    agentPickerEffectiveChoices(own, editAgentPickerArguments(draft, '--add-dir src')).model
  ).toBeUndefined()
  expect(agentPickerEffectiveChoices(own, { ...draft, surface: 'chat' }).model).toBe('opus')
  expect(
    agentPickerEffectiveChoices(own, editAgentPickerDraft(draft, { model: 'opus' })).model
  ).toBe('opus')
})

it('clears an Arguments-owned model/effort through deliberate controls without copying other CLI choices into Chat', () => {
  const own = { ...entry, agent: 'claude' as const }
  const original = editAgentPickerDraft(agentPickerDraft(own), {
    model: 'sonnet',
    permissionMode: 'ask'
  })
  const edited = editAgentPickerArguments(
    original,
    '--model opus --effort low --dangerously-skip-permissions --add-dir docs'
  )
  const cleared = editAgentPickerDraft(edited, { model: null, options: { effort: null } })
  expect(cleared.arguments).toBe('--dangerously-skip-permissions --add-dir docs')
  expect(cleared.choices).toEqual({ permissionMode: 'ask' })
  expect(agentPickerLaunchInputs({ ...cleared, surface: 'chat' }, own)).toEqual({
    sessionOptions: { permissionMode: 'ask' },
    agentArgs: '--dangerously-skip-permissions --add-dir docs'
  })
  const next = editAgentPickerDraft(edited, { model: 'sonnet' })
  expect(agentPickerLaunchInputs({ ...next, surface: 'chat' }, own).sessionOptions).toEqual({
    model: 'sonnet',
    permissionMode: 'ask'
  })
  expect(agentPickerLaunchInputs({ ...next, surface: 'terminal' }, own).agentArgs).toContain(
    '--dangerously-skip-permissions'
  )
})

it('uses the common Cursor composed model carrier for both Fast directions without duplicate model flags', async () => {
  const { agentPickerPanelArguments } = await import('./agent-launch-picker-arguments')
  const { applyAgentPickerEdit, acceptAgentPickerArguments } =
    await import('./agent-launch-picker-edits')
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'cursor',
    defaultSurface: 'terminal',
    terminal: { model: 'gpt-5.3-codex', options: { effort: 'low', fastMode: 'false' } },
    structured: {},
    arguments: '--add-dir docs',
    catalog: { origin: 'unknown' }
  }
  const fast = applyAgentPickerEdit(own, agentPickerDraft(own), {
    kind: 'speed',
    key: 'fastMode',
    value: 'true',
    model: 'gpt-5.3-codex'
  })
  expect(agentPickerLaunchInputs(fast, own).agentArgs).toBe(
    '--model gpt-5.3-codex-low-fast --add-dir docs'
  )
  const view = agentPickerPanelArguments(own, fast)
  expect(view.text).toBe('--add-dir docs')
  const edited = acceptAgentPickerArguments(
    own,
    applyAgentPickerEdit(own, fast, {
      kind: 'arguments',
      text: '--add-dir src'
    })
  )
  expect(agentPickerLaunchInputs(edited, own).agentArgs).toBe(
    '--model gpt-5.3-codex-low-fast --add-dir src'
  )
  const normal = applyAgentPickerEdit(own, fast, {
    kind: 'speed',
    key: 'fastMode',
    value: 'false',
    model: 'gpt-5.3-codex'
  })
  expect(agentPickerLaunchInputs(normal, own).agentArgs).toBe(
    '--model gpt-5.3-codex-low --add-dir docs'
  )
  expect(agentPickerLaunchInputs({ ...normal, surface: 'chat' }, own)).toEqual({
    sessionOptions: { fastMode: 'false', model: 'gpt-5.3-codex-low' },
    chatSessionOptions: { fastMode: 'false' },
    agentArgs: '--model gpt-5.3-codex-low --add-dir docs'
  })
})

it('reports opaque permission literally when the actual compiler ignores a different selected Terminal policy', async () => {
  const { editAgentPickerPermission, agentPickerPermissionValue } =
    await import('./agent-launch-picker-permission')
  const { agentPickerPanelArguments } = await import('./agent-launch-picker-arguments')
  const raw = '--unknown value --permission-mode plan --add-dir docs'
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'claude',
    defaultSurface: 'terminal',
    arguments: raw
  }
  const next = editAgentPickerPermission(own, agentPickerDraft(own), 'full-access')
  expect(agentPickerPermissionValue(own, next)).toBe('plan')
  expect(agentPickerPanelArguments(own, next).text).toBe(raw)
  expect(agentPickerLaunchInputs(next, own).agentArgs).toBe(raw)
  expect(agentPickerLaunchInputs({ ...next, surface: 'chat' }, own)).toEqual({
    sessionOptions: { permissionMode: 'full-access' },
    agentArgs: raw
  })
})

it('retains a raw permission spelling even when its literal value happens to name a typed choice', async () => {
  const { agentPickerPanelArguments } = await import('./agent-launch-picker-arguments')
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'claude',
    defaultSurface: 'terminal',
    arguments: '--permission-mode ask --add-dir docs'
  }
  const view = agentPickerPanelArguments(own, agentPickerDraft(own))
  expect(view.permission).toBe('ask')
  expect(view.selectedPermission).toBeUndefined()
})

it('keeps offered host Chat independent of preference through the actual row builder and adapter', () => {
  for (const scenario of [
    {
      defaultMode: 'chat',
      preferred: undefined,
      answer: 'yes',
      program: 'available',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'chat'
    },
    {
      defaultMode: 'terminal',
      preferred: undefined,
      answer: 'yes',
      program: 'available',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: false,
      answer: 'yes',
      program: 'available',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: true,
      answer: 'yes',
      program: 'available',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'chat'
    },
    {
      defaultMode: 'terminal',
      preferred: false,
      answer: 'yes',
      program: 'available',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: false,
      answer: 'ssh',
      program: 'available',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: false,
      answer: 'not-yet-known',
      program: 'available',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: false,
      answer: 'yes',
      program: 'installable',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: false,
      answer: 'yes',
      program: 'unknown',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: false,
      answer: 'no-chats',
      program: 'available',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: false,
      answer: 'yes',
      program: 'missing',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      defaultMode: 'chat',
      preferred: true,
      answer: 'yes',
      program: 'available',
      detected: [],
      surfaces: ['chat'],
      defaultSurface: 'chat'
    }
  ] as const) {
    const rows = buildNewTabAgentMenuRows({
      settings: {
        agentDefaultSurface: scenario.defaultMode,
        nativeChatProviders: scenario.preferred === undefined ? {} : { codex: scenario.preferred }
      },
      detectedOnHost: scenario.detected,
      chatAgents: ['codex'],
      hostChatAnswer: () => scenario.answer,
      chatProgram: () => scenario.program
    }).map((row) => ({ ...row, executionHostId: 'runtime:paired' as const }))
    const [result] = agentPickerEntriesFromRows(
      rows,
      scenario.detected,
      () => ({ terminal: {}, structured: {} }),
      (agent) => agent,
      undefined
    )
    expect(result.surfaces).toEqual(scenario.surfaces)
    expect(result.defaultSurface).toBe(scenario.defaultSurface)
    expect(result.rows.every((row) => row.executionHostId === 'runtime:paired')).toBe(true)
  }
  for (const answer of ['not-yet-known', 'ssh', 'wsl', 'subfolder', 'not-on-host'] as const) {
    for (const detected of [[], ['codex']] as const) {
      const rows = buildNewTabAgentMenuRows({
        settings: { agentDefaultSurface: 'chat' },
        detectedOnHost: detected,
        chatAgents: ['codex'],
        hostChatAnswer: () => answer,
        chatProgram: () => 'available'
      })
      const [result] = agentPickerEntriesFromRows(
        rows,
        detected,
        () => ({ terminal: {}, structured: {} }),
        (agent) => agent,
        undefined
      )
      expect(result.rows.some((row) => row.kind === 'chat-unavailable')).toBe(true)
      expect(result.surfaces).toEqual(detected.length ? ['terminal'] : [])
    }
  }
  expect(
    buildNewTabAgentMenuRows({
      settings: { agentDefaultSurface: 'chat', disabledTuiAgents: ['codex'] },
      detectedOnHost: ['codex'],
      chatAgents: ['codex'],
      hostChatAnswer: () => 'yes',
      chatProgram: () => 'available'
    })
  ).toEqual([])
})

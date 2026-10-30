import { buildNewTabAgentMenuRows } from './agent-launch-picker-rows'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  agentPickerLaunchInputs,
  agentPickerEntriesFromRows,
  agentPickerChoiceSeeds,
  agentPickerDraft,
  agentPickerHydrationQueue,
  agentPickerEntryOptions,
  agentPickerSessionOptions,
  agentPickerEffectiveChoices,
  agentPickerButtonOrder,
  searchAgentPickerSetups,
  editAgentPickerDraft,
  editAgentPickerArguments,
  type AgentPickerEntry
} from './agent-launch-picker'

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
  it('keeps ordinary launch unconfigured and the existing default on the right', () => {
    expect(agentPickerDraft(entry)).toEqual({
      agent: 'codex',
      surface: 'chat',
      choices: {},
      arguments: undefined
    })
    expect(agentPickerEffectiveChoices(entry, agentPickerDraft(entry))).toEqual(entry.structured)
    expect(agentPickerEffectiveChoices(entry, agentPickerDraft(entry, 'terminal'))).toEqual(
      entry.terminal
    )
    expect(agentPickerButtonOrder(entry)).toEqual(['terminal', 'chat'])
    expect(agentPickerButtonOrder({ ...entry, defaultSurface: 'terminal' })).toEqual([
      'chat',
      'terminal'
    ])
  })
  it('derives setup matches from every query word, folds extra high and leaves plain agent searches plain', () => {
    expect(searchAgentPickerSetups([entry], 'codex')).toEqual([])
    expect(searchAgentPickerSetups([entry], 'astra low')[0]?.choices).toEqual({
      model: 'astra',
      options: { effort: 'low' }
    })
    expect(
      searchAgentPickerSetups([entry], 'codex astra extra high')[0]?.choices.options?.effort
    ).toBe('xhigh')
    expect(searchAgentPickerSetups([entry], 'astra unsupported')).toEqual([])
    expect(searchAgentPickerSetups([entry], 'astra')).toHaveLength(1)
  })
  it('keeps unknown saved models launchable while current search excludes a classified legacy model', () => {
    const legacy = {
      ...entry,
      catalog: {
        origin: 'probe' as const,
        fetchedAt: 1,
        models: [
          {
            id: 'retired',
            label: 'Retired',
            isDefault: false,
            efforts: [],
            isLegacy: true as const
          }
        ]
      }
    }
    expect(searchAgentPickerSetups([legacy], 'retired')).toEqual([])
    const draft = editAgentPickerDraft(agentPickerDraft(entry), { model: 'my-private-alias' })
    expect(editAgentPickerDraft(draft, { permissionMode: 'own' }).choices).toEqual({
      model: 'my-private-alias',
      permissionMode: 'own'
    })
  })
  it('reconciles deliberate Arguments edits once and preserves explicit empty versus inheritance', () => {
    const draft = editAgentPickerArguments(
      agentPickerDraft(entry, 'terminal'),
      '--model astra --add-dir docs'
    )
    expect(draft.choices.model).toBeUndefined()
    expect(agentPickerLaunchInputs(draft, entry).sessionOptions?.model).toBe('astra')
    expect(draft.arguments).toBe('--model astra --add-dir docs')
    expect(editAgentPickerArguments(draft, '').arguments).toBeNull()
    expect(agentPickerDraft(entry).arguments).toBeUndefined()
  })
  it('uses live effort facts for an opaque model and emits an independent effort', () => {
    expect(
      agentPickerEntryOptions(entry, 'astra', 'terminal').find((option) => option.id === 'effort')
        ?.kind
    ).toMatchObject({
      type: 'select',
      choices: entry.catalog.origin !== 'unknown' ? entry.catalog.models[0].efforts : []
    })
    expect(agentPickerSessionOptions({ options: { effort: 'low' } })).toEqual({ effort: 'low' })
  })
  it('bounds suggestions without mutating the inventory or creating saved setups', () => {
    const large = {
      ...entry,
      catalog: {
        origin: 'probe' as const,
        fetchedAt: 1,
        models: Array.from({ length: 80 }, (_, id) => ({
          id: `astra-${id}`,
          label: `Astra ${id}`,
          isDefault: false,
          efforts: []
        }))
      }
    }
    expect(searchAgentPickerSetups([large], 'astra')).toHaveLength(8)
    expect(large.catalog.models).toHaveLength(80)
  })
})

it('prioritizes the selected pending catalog and reads each offered agent only once', () => {
  let selected: AgentPickerEntry['agent'] | undefined
  const entries = [
    entry,
    { ...entry, agent: 'claude' as const },
    { ...entry, agent: 'gemini' as const },
    { ...entry, agent: 'grok' as const, surfaces: [] }
  ]
  const next = agentPickerHydrationQueue(entries, () => selected)
  expect(next()).toBe(0)
  selected = 'gemini'
  expect(next()).toBe(2)
  expect(next()).toBe(1)
  expect(next()).toBeUndefined()
})
it('retains a model named by a captured Claude init and honors its disabled fast mode', () => {
  const initSchema = z.object({
    frame: z.object({
      type: z.literal('system'),
      subtype: z.literal('init'),
      model: z.string(),
      fast_mode_disabled_reason: z.literal('sdk_opt_in_required')
    })
  })
  const capture = readFileSync(
    new URL('../main/claude/__fixtures__/claude-adapter-capture-fold.jsonl', import.meta.url),
    'utf8'
  )
  const init = capture
    .trim()
    .split('\n')
    .map((line) => initSchema.safeParse(JSON.parse(line)))
    .find((result) => result.success)
  if (!init?.success) {
    throw new Error('Captured init is missing')
  }
  const model = init.data.frame.model
  const captured: AgentPickerEntry = {
    ...entry,
    agent: 'claude',
    catalog: {
      origin: 'live-session',
      fetchedAt: 1,
      fastModeSupport: { supported: false, reason: init.data.frame.fast_mode_disabled_reason },
      models: [{ id: model, label: model, isDefault: false, efforts: [], effortsKnown: false }]
    }
  }
  expect(
    agentPickerEntryOptions(captured, model, 'chat').some((option) => option.id === 'fastMode')
  ).toBe(false)
  expect(editAgentPickerDraft(agentPickerDraft(captured), { model }).choices.model).toBe(model)
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
      sessionOptions: { model: 'my-private-alias', permissionMode: 'ask' }
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

it('only suggests host-advertised model words and preserves the mixed omnibox short-prefix boundary', () => {
  expect(
    searchAgentPickerSetups([{ ...entry, catalog: { origin: 'unknown' } }], 'gpt low')
  ).toEqual([])
  for (const query of ['a', 'low', 'high', 'codex low']) {
    expect(searchAgentPickerSetups([entry], query)).toEqual([])
  }
  expect(searchAgentPickerSetups([entry], 'as low')).toHaveLength(1)
})

it('bounds real setup search work at N and 10N for no, broad and effort matches', () => {
  const measure = (count: number, query: string) => {
    let visits = 0
    const models = Array.from({ length: count }, (_, index) => ({
      ...(entry.catalog.origin !== 'unknown'
        ? entry.catalog.models[0]
        : { isDefault: false, efforts: [] }),
      get id() {
        visits++
        return `astra-${index}`
      },
      get label() {
        visits++
        return `Astra ${index}`
      }
    }))
    const result = searchAgentPickerSetups(
      [{ ...entry, catalog: { origin: 'probe', fetchedAt: 1, models } }],
      query
    )
    return { visits, length: result.length }
  }
  for (const query of ['absent', 'astra', 'astra low', 'low']) {
    const small = measure(30, query),
      large = measure(300, query)
    expect(large.visits).toBeLessThanOrEqual(10 * small.visits)
    expect(large.visits).toBeGreaterThan(0)
    expect(large.length).toBeLessThanOrEqual(8)
  }
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
    sessionOptions: { permissionMode: 'ask' }
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
  const { editAgentPickerSpeed, agentPickerPanelArguments, editAgentPickerPanelText } =
    await import('./agent-launch-picker-arguments')
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'cursor',
    defaultSurface: 'terminal',
    terminal: { model: 'gpt-5.3-codex', options: { effort: 'low', fastMode: 'false' } },
    structured: {},
    arguments: '--add-dir docs',
    catalog: { origin: 'unknown' }
  }
  const fast = editAgentPickerSpeed(own, agentPickerDraft(own), 'fastMode', 'true', 'gpt-5.3-codex')
  expect(agentPickerLaunchInputs(fast, own).agentArgs).toBe(
    '--model gpt-5.3-codex-low-fast --add-dir docs'
  )
  const view = agentPickerPanelArguments(own, fast, 'gpt-5.3-codex')
  expect(view.text).toBe('--add-dir docs')
  expect(view.chips.filter((chip) => chip.key === 'fastMode')).toHaveLength(1)
  const edited = editAgentPickerPanelText(own, fast, '--add-dir src', 'gpt-5.3-codex')
  expect(agentPickerLaunchInputs(edited, own).agentArgs).toBe(
    '--model gpt-5.3-codex-low-fast --add-dir src'
  )
  const normal = editAgentPickerSpeed(own, fast, 'fastMode', 'false', 'gpt-5.3-codex')
  expect(agentPickerLaunchInputs(normal, own).agentArgs).toBe(
    '--model gpt-5.3-codex-low --add-dir docs'
  )
  expect(agentPickerLaunchInputs({ ...normal, surface: 'chat' }, own)).toEqual({
    sessionOptions: { fastMode: 'false' }
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
  expect(agentPickerPanelArguments(own, next).chips).toEqual([])
  expect(agentPickerLaunchInputs(next, own).agentArgs).toBe(raw)
  expect(agentPickerLaunchInputs({ ...next, surface: 'chat' }, own)).toEqual({
    sessionOptions: { permissionMode: 'full-access' }
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
  expect(view.chips[0].flag).toBe('--permission-mode ask')
})

it('keeps offered host Chat independent of preference through the actual row builder and adapter', () => {
  for (const scenario of [
    {
      enabled: true,
      preferred: false,
      answer: 'yes',
      program: 'available',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal'
    },
    {
      enabled: true,
      preferred: true,
      answer: 'yes',
      program: 'available',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'chat'
    },
    {
      enabled: false,
      preferred: false,
      answer: 'yes',
      program: 'available',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      enabled: true,
      preferred: false,
      answer: 'ssh',
      program: 'available',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      enabled: true,
      preferred: false,
      answer: 'not-yet-known',
      program: 'available',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      enabled: true,
      preferred: false,
      answer: 'yes',
      program: 'installable',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal'
    },
    {
      enabled: true,
      preferred: false,
      answer: 'yes',
      program: 'unknown',
      detected: ['codex'],
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal'
    },
    {
      enabled: true,
      preferred: false,
      answer: 'no-chats',
      program: 'available',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      enabled: true,
      preferred: false,
      answer: 'yes',
      program: 'missing',
      detected: ['codex'],
      surfaces: ['terminal'],
      defaultSurface: 'terminal'
    },
    {
      enabled: true,
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
        experimentalNativeChat: scenario.enabled,
        nativeChatProviders: { codex: scenario.preferred }
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
      (agent) => agent
    )
    expect(result.surfaces).toEqual(scenario.surfaces)
    expect(result.defaultSurface).toBe(scenario.defaultSurface)
    expect(result.rows.every((row) => row.executionHostId === 'runtime:paired')).toBe(true)
  }
  for (const answer of ['not-yet-known', 'ssh', 'wsl', 'subfolder', 'not-on-host'] as const) {
    for (const detected of [[], ['codex']] as const) {
      const rows = buildNewTabAgentMenuRows({
        settings: { experimentalNativeChat: true },
        detectedOnHost: detected,
        chatAgents: ['codex'],
        hostChatAnswer: () => answer,
        chatProgram: () => 'available'
      })
      const [result] = agentPickerEntriesFromRows(
        rows,
        detected,
        () => ({ terminal: {}, structured: {} }),
        (agent) => agent
      )
      expect(result.rows.some((row) => row.kind === 'chat-unavailable')).toBe(true)
      expect(result.surfaces).toEqual(detected.length ? ['terminal'] : [])
    }
  }
  expect(
    buildNewTabAgentMenuRows({
      settings: { experimentalNativeChat: true, disabledTuiAgents: ['codex'] },
      detectedOnHost: ['codex'],
      chatAgents: ['codex'],
      hostChatAnswer: () => 'yes',
      chatProgram: () => 'available'
    })
  ).toEqual([])
})

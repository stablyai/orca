// @vitest-environment happy-dom
import {
  AgentLaunchSetupPanel,
  entry,
  host,
  root,
  onUse
} from './agent-launch-setup-panel-test-fixture'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { readPiRpcModelOptions } from '../../../../main/pi/rpc-model-options'

import {
  agentPickerDraft,
  agentPickerModels,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

it.each([`--settings '{"fastMode":true}' --settings ./team.json`, `--settings '{broken'`])(
  'keeps opaque effective settings literal and Fast unclaimed: %s',
  (args) => {
    const own: AgentPickerEntry = {
      ...entry,
      defaultSurface: 'terminal',
      terminal: { model: 'opus', permissionMode: 'ask' },
      structured: { model: 'opus', permissionMode: 'ask', options: { fastMode: 'true' } },
      arguments: args,
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          { id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true }
        ]
      }
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={own} onUse={onUse} />
        </TooltipProvider>
      )
    )
    expect(host.textContent).toContain('Set by your Arguments')
    expect(host.querySelector('[role="switch"]')).toBeNull()
    expect(host.querySelector('button[aria-label*="Remove --settings"]')).toBeNull()
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.value).toBe(
      args
    )
    for (const way of ['Launch chat', 'Launch terminal']) {
      onUse.mockClear()
      fireEvent.click(
        [...host.querySelectorAll('button')].find((button) => button.textContent === way)!
      )
      const input = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
      expect(input.sessionOptions?.fastMode).toBeUndefined()
      expect(input).not.toHaveProperty('agentArgs')
    }
  }
)

it.each(['direct Use', 'blur then Use'] as const)(
  'retains the latest full buffer until acceptance through %s',
  (acceptance) => {
    const own: AgentPickerEntry = {
      ...entry,
      terminal: {},
      structured: {},
      arguments: '',
      ownerKey: 'buffer-owner'
    }
    const change = vi.fn()
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={own} mode="select" onDraftChange={change} onUse={onUse} />
        </TooltipProvider>
      )
    )
    const input = host.querySelector<HTMLTextAreaElement>('textarea')!
    const text = '--model sonnet --effort high --verbose'
    for (let length = 1; length <= text.length; length++) {
      fireEvent.change(input, { target: { value: text.slice(0, length) } })
      expect(input.value).toBe(text.slice(0, length))
      expect(change.mock.calls.at(-1)?.[0].choices.model).toBeUndefined()
      expect(host.querySelector('button[aria-label="Remove --model s"]')).toBeNull()
    }
    fireEvent.change(input, { target: { value: '--debug' } })
    if (acceptance === 'blur then Use') {
      fireEvent.blur(input)
    }
    fireEvent.click(
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Use')!
    )
    expect(onUse).toHaveBeenCalledOnce()
    const accepted = onUse.mock.calls[0][0]
    expect(accepted.pendingArguments).toBeUndefined()
    expect(accepted.arguments).toBe('--debug')
    expect(accepted.choices.model).toBeUndefined()
    expect(accepted.choices.options?.effort).toBeUndefined()
    expect(
      agentPickerLaunchInputs({ ...accepted, surface: 'chat' }, own).sessionOptions?.model
    ).toBeUndefined()
  }
)

it.each(['pending click', 'blur then click'] as const)(
  'removes the current model domain after accepting newer text through %s',
  async (transition) => {
    const reconcile = await import('../../../../shared/agent-choice-reconciliation')
    const accepted = vi.spyOn(reconcile, 'reconcileAgentChoiceArgsDetailed')
    const own: AgentPickerEntry = {
      ...entry,
      terminal: {},
      structured: {},
      arguments: '--verbose'
    }
    try {
      act(() =>
        root.render(
          <TooltipProvider>
            <AgentLaunchSetupPanel
              entry={own}
              mode="select"
              initial={{ ...agentPickerDraft(own), choices: { model: 'sonnet' } }}
              onUse={onUse}
            />
          </TooltipProvider>
        )
      )
      const remove = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove --model sonnet"]'
      )!
      const input = host.querySelector<HTMLTextAreaElement>('textarea')!
      const pending = '--model opus --debug'
      fireEvent.change(input, { target: { value: pending } })
      accepted.mockClear()
      if (transition === 'blur then click') {
        fireEvent.blur(input)
      }
      fireEvent.click(remove)
      fireEvent.click(
        [...host.querySelectorAll('button')].find((button) => button.textContent === 'Use')!
      )
      expect(
        accepted.mock.calls.filter(
          ([value]) => value.mode === 'arguments-edit' && value.userArgs === pending
        )
      ).toHaveLength(1)
      expect(onUse).toHaveBeenCalledOnce()
      const draft = onUse.mock.calls[0][0]
      expect(draft.pendingArguments).toBeUndefined()
      expect(draft.delegated).toContain('model')
      expect(draft.choices.model).toBeUndefined()
      for (const surface of ['chat', 'terminal'] as const) {
        const launch = agentPickerLaunchInputs({ ...draft, surface }, own)
        expect(launch.sessionOptions?.model).toBeUndefined()
        if (surface === 'terminal') {
          expect(launch.agentArgs).toBe('--debug')
        }
      }
    } finally {
      accepted.mockRestore()
    }
  }
)

it('explains no-flag choices from the recorded Pi catalog and keeps them usable for Chat', async () => {
  const recording = readFileSync('src/main/pi/__fixtures__/command-only.jsonl', 'utf8')
  const responses = recording
    .trim()
    .split('\n')
    .map((line) => {
      const row = z.object({ raw: z.string() }).parse(JSON.parse(line))
      return z
        .object({ command: z.string().optional(), data: z.unknown().optional() })
        .parse(JSON.parse(row.raw))
    })
  const models = await readPiRpcModelOptions({
    request: async () => responses.find((row) => row.command === 'get_available_models')?.data
  })
  const own: AgentPickerEntry = {
    agent: 'pi',
    label: 'Pi',
    rows: [{ agent: 'pi', kind: 'chat' }],
    surfaces: ['chat', 'terminal'],
    defaultSurface: 'chat',
    terminal: { permissionMode: 'own' },
    structured: { permissionMode: 'own' },
    arguments: '',
    catalog: { origin: 'probe', fetchedAt: 1, listingNamesConfiguredModel: false, models }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={own} onUse={onUse} />
      </TooltipProvider>
    )
  )
  fireEvent.click(host.querySelector('[cmdk-item][data-value="openai-codex/gpt-5.5"]')!)
  fireEvent.click(
    [...host.querySelectorAll('[role="radio"]')].find(
      (radio) => radio.textContent?.toLowerCase() === 'high'
    )!
  )
  fireEvent.click(host.querySelector('button[aria-label="Toggle Arguments"]')!)
  expect(host.textContent).toContain(
    'Pi model or effort choices without a CLI flag apply to chats.'
  )
  expect(host.textContent).toContain('Only applies to terminal (CLI) launches')
  expect(host.querySelector('button[aria-label^="Remove "]')).toBeNull()
  for (const surface of ['chat', 'terminal'] as const) {
    onUse.mockClear()
    fireEvent.click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === `Launch ${surface}`
      )!
    )
    expect(onUse).toHaveBeenCalledOnce()
    const launch = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
    expect(launch.sessionOptions).toMatchObject({ model: 'openai-codex/gpt-5.5', effort: 'high' })
    expect(launch.agentArgs ?? '').toBe('')
  }
})

it('bounds whole current-snapshot work on rendered replacement, acceptance and chip removal', async () => {
  const args = await import('../../../../shared/agent-choice-args')
  const reconcile = await import('../../../../shared/agent-choice-reconciliation')
  const profile = await import('../../../../shared/agent-launch-profile')
  const catalog = await import('../../../../shared/agent-session-option-catalog')
  const reconciliation = vi.spyOn(reconcile, 'reconcileAgentChoiceArgsDetailed')
  const spies = [
    vi.spyOn(args, 'analyzeAgentChoiceArgs'),
    reconciliation,
    vi.spyOn(profile, 'projectAgentLaunchProfile'),
    vi.spyOn(catalog, 'getAgentSessionOptionLaunchCatalog')
  ]
  const counts = () => spies.map((spy) => spy.mock.calls.length)
  const chips = await import('../settings/agent-model-choice-chips')
  const buildChips = chips.agentModelChoiceChips
  const projectionPasses: { counts: number[]; permission: boolean }[] = []
  const chipBuilder = vi.spyOn(chips, 'agentModelChoiceChips').mockImplementation((...input) => {
    const before = counts()
    const result = buildChips(...input)
    if (input[2]?.model) {
      projectionPasses.push({
        counts: counts().map((count, index) => count - before[index]),
        permission: Boolean(input[2]?.permissionMode && input[2]?.permissionMode !== 'own')
      })
    }
    return result
  })
  const clear = () => spies.forEach((spy) => spy.mockClear())
  const available = agentPickerModels({
    ...entry,
    agent: 'codex',
    catalog: { origin: 'unknown' }
  }).sort((a, b) => Number(b.id === 'gpt-5.6-sol') - Number(a.id === 'gpt-5.6-sol'))
  const measure = (
    events: number,
    many: boolean,
    population = 1,
    textCopies = 1,
    permission = many
  ) => {
    const own: AgentPickerEntry = {
      ...entry,
      agent: 'codex',
      label: 'Codex',
      arguments: '--search',
      terminal: {},
      structured: {},
      catalog: { origin: 'probe', fetchedAt: 1, models: available.slice(0, population) }
    }
    const initial = {
      ...agentPickerDraft(own),
      choices: {
        model: 'gpt-5.6-sol',
        ...(many ? { options: { effort: 'high', serviceTier: 'priority' } } : {}),
        ...(permission ? { permissionMode: 'ask' as const } : {})
      }
    }
    const changes = vi.fn()
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            key={`${events}-${many}-${population}-${textCopies}-${permission}`}
            entry={own}
            initial={initial}
            mode="select"
            onDraftChange={changes}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
    const input = host.querySelector<HTMLTextAreaElement>('textarea')!
    const chipCount = host.querySelectorAll('button[aria-label^="Remove "]').length
    clear()
    for (let index = 0; index < events; index++) {
      fireEvent.change(input, {
        target: { value: `${'--search '.repeat(textCopies)}--add-dir folder${index % 10}` }
      })
    }
    const typing = counts()
    expect(reconciliation.mock.calls.every(([input]) => input.mode !== 'arguments-edit')).toBe(true)
    expect(changes.mock.calls.at(-1)?.[0].pendingArguments).toHaveLength(17 + textCopies * 9)
    clear()
    fireEvent.click(
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Use')!
    )
    const acceptance = counts()
    const accepted = onUse.mock.calls.at(-1)![0]
    expect(accepted.pendingArguments).toBeUndefined()
    expect(accepted.choices.model).toBe('gpt-5.6-sol')
    expect(JSON.stringify(accepted)).not.toContain('folder0folder1')
    clear()
    fireEvent.click(host.querySelector('button[aria-label="Remove -m gpt-5.6-sol"]')!)
    const removal = counts()
    expect(host.querySelector('button[aria-label="Remove -m gpt-5.6-sol"]')).toBeNull()
    return { typing, acceptance, removal, chipCount, retained: JSON.stringify(accepted).length }
  }
  try {
    const n = measure(3, false)
    const tenN = measure(30, false)
    const many = measure(30, true)
    const optionsOnly = measure(30, true, 1, 1, false)
    const populated = measure(30, true, available.length, 10)
    expect(many.chipCount).toBeGreaterThan(n.chipCount)
    for (let index = 0; index < spies.length; index++) {
      expect(tenN.typing[index]).toBeLessThanOrEqual(n.typing[index] * 10 + 4)
      expect(many.typing[index]).toBeLessThanOrEqual(tenN.typing[index] + 120)
      expect(tenN.acceptance[index]).toBeLessThanOrEqual(n.acceptance[index] + 4)
      expect(many.acceptance[index]).toBeLessThanOrEqual(tenN.acceptance[index] + 4)
      expect(many.removal[index]).toBeLessThanOrEqual(tenN.removal[index] + (index === 3 ? 8 : 4))
    }
    expect(tenN.retained).toBe(n.retained)
    expect(
      projectionPasses.every(({ counts }) => JSON.stringify(counts.slice(0, 3)) === '[1,0,1]')
    ).toBe(true)
    for (const permission of [true, false]) {
      const lookups = projectionPasses
        .filter((pass) => pass.permission === permission)
        .map(({ counts }) => counts[3])
      expect(new Set(lookups).size).toBe(1)
    }
    expect(optionsOnly.chipCount).toBeGreaterThan(n.chipCount)
    expect(populated.retained).toBeLessThan(many.retained + 100)
    for (let index = 0; index < spies.length; index++) {
      expect(populated.acceptance[index]).toBeLessThanOrEqual(many.acceptance[index] + 4)
      expect(populated.removal[index]).toBeLessThanOrEqual(many.removal[index] + 4)
    }
    console.info(
      JSON.stringify({
        metric: 'rendered-picker-snapshot',
        n,
        tenN,
        many,
        optionsOnly,
        populated,
        chipProjection: [...new Set(projectionPasses.map((pass) => JSON.stringify(pass)))]
      })
    )
  } finally {
    chipBuilder.mockRestore()
    spies.forEach((spy) => spy.mockRestore())
  }
})

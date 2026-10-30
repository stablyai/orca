import {
  normalizeSourceControlActionRecipe,
  readSourceControlActionDefault,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import { liftActionPermissionArgs } from './source-control-action-permission-lift'
import {
  lowerActionArgumentChoices,
  readActionArgumentNode,
  transportActionArgumentChoices,
  editActionArgumentChoices
} from './source-control-action-argument-choices'
import * as startupShell from './tui-agent-startup-shell'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import { describe, expect, it, vi } from 'vitest'
import * as choiceArgs from './agent-choice-args'
import { normalizeAgentModelOptionChoices } from './agent-launch-choices'
import { reconcileAgentChoiceArgs } from './agent-choice-reconciliation'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import { agentLaunchNeedsPreparedCommand } from './agent-launch-preferences'

const keys = new Set(['model', 'effort', 'permissionMode'])
const load = (agent: 'claude' | 'codex', userArgs: string) =>
  reconcileAgentChoiceArgs({ agent, userArgs, choices: {}, mode: 'load', keys })

describe('dedicated agent choices', () => {
  it.each([
    ['-c modelx', undefined, false],
    ['--config=modelx', undefined, false],
    ['-c model_reasoning_effortx', undefined, false],
    ['-c model=value', { model: 'value' }, true],
    ['-c model_reasoning_effort=low', { options: { effort: 'low' } }, true],
    ['-c model=42', undefined, true]
  ] as const)('requires a config assignment for %s ownership', (userArgs, choices, owned) => {
    const migrated = load('codex', userArgs)
    const patch = { model: 'gpt-5.5', options: { effort: 'high' } }
    const edited = reconcileAgentChoiceArgs({
      agent: 'codex',
      userArgs,
      choices: {},
      mode: 'choice-edit',
      keys,
      patch
    })
    const projected = projectAgentLaunchProfile(
      'codex',
      { agentPermissionDefault: 'own' },
      { target: 'terminal', userArgs, choices: patch }
    )
    expect.soft(migrated).toEqual(choices ? { userArgs: '', choices } : { userArgs, choices: {} })
    expect.soft(edited).toEqual({ userArgs: owned ? '' : userArgs, choices: patch })
    expect(projected.args).toBe(
      ['-m gpt-5.5 -c model_reasoning_effort=high', owned ? '' : userArgs].filter(Boolean).join(' ')
    )
  })

  it('bounds range comparisons and copied bytes on repeated-flag choice edits', () => {
    const analyze = choiceArgs.analyzeAgentChoiceArgs
    const slice = String.prototype.slice
    const join = Array.prototype.join
    let cutting = false
    let work = { rangeEndpointReads: 0, copiedBytes: 0 }
    const sliceSpy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start,
      end
    ) {
      const result = slice.call(this, start, end)
      if (cutting) {
        work.copiedBytes += result.length
      }
      return result
    })
    const joinSpy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator
    ) {
      const result = join.call(this, separator)
      if (cutting) {
        work.copiedBytes += result.length
      }
      return result
    })
    const analyzeSpy = vi
      .spyOn(choiceArgs, 'analyzeAgentChoiceArgs')
      .mockImplementation((...args) => {
        const analysis = analyze(...args)
        return {
          ...analysis,
          cut: (selected) => {
            const measured = selected.map((entry) => ({
              ...entry,
              get start() {
                work.rangeEndpointReads++
                return entry.start
              },
              get end() {
                work.rangeEndpointReads++
                return entry.end
              }
            }))
            cutting = true
            try {
              return analysis.cut(measured)
            } finally {
              cutting = false
            }
          }
        }
      })
    const measure = (count: number) => {
      const userArgs = `--append-system-prompt before ${'--model opus --append-system-prompt keep '.repeat(count)}--append-system-prompt after`
      work = { rangeEndpointReads: 0, copiedBytes: 0 }
      expect(
        reconcileAgentChoiceArgs({
          agent: 'claude',
          userArgs,
          choices: { model: 'opus' },
          mode: 'choice-edit',
          keys,
          patch: { model: 'sonnet' }
        })
      ).toEqual({
        userArgs: `--append-system-prompt before ${' --append-system-prompt keep '.repeat(count)}--append-system-prompt after`,
        choices: { model: 'sonnet' }
      })
      return { count, inputBytes: userArgs.length, ...work }
    }
    try {
      const small = measure(128)
      const large = measure(1280)
      console.info('choice-edit cut work', { small, large })
      expect(small.rangeEndpointReads).toBeGreaterThan(small.count)
      expect(small.copiedBytes).toBeGreaterThan(0)
      expect(large.rangeEndpointReads).toBeLessThanOrEqual(small.rangeEndpointReads * 12)
      expect(large.copiedBytes).toBeLessThanOrEqual(small.copiedBytes * 12)
      expect(large.rangeEndpointReads).toBeLessThan(large.count * 64)
      expect(large.copiedBytes).toBeLessThan(large.inputBytes * 20)
    } finally {
      analyzeSpy.mockRestore()
      joinSpy.mockRestore()
      sliceSpy.mockRestore()
    }
  })

  it('retains independent options and bounded opaque model ids without discovery', () => {
    expect(normalizeAgentModelOptionChoices({ options: { effort: 'high' } })).toEqual({
      options: { effort: 'high' }
    })
    expect(normalizeAgentModelOptionChoices({ model: 'retired-unlisted-id' })).toEqual({
      model: 'retired-unlisted-id'
    })
    expect(normalizeAgentModelOptionChoices({ options: { model: 'other' } })).toBeUndefined()
    expect(normalizeAgentModelOptionChoices({ model: 'x'.repeat(513) })).toBeUndefined()
  })

  it('lifts a complete tuple atomically and keeps surviving raw bytes', () => {
    expect(
      load('claude', '--model saved-unlisted-id  --effort high --permission-mode auto')
    ).toEqual({
      userArgs: '',
      choices: { model: 'saved-unlisted-id', options: { effort: 'high' }, permissionMode: 'auto' }
    })
    expect(load('codex', '-c model=opus --search -c model_reasoning_effort=high')).toEqual({
      userArgs: '--search',
      choices: { model: 'opus', options: { effort: 'high' } }
    })
    expect(load('claude', '--effort high')).toEqual({
      userArgs: '',
      choices: { options: { effort: 'high' } }
    })
    expect(load('claude', '--model opus --append-system-prompt "keep  spacing"').userArgs).toBe(
      '--append-system-prompt "keep  spacing"'
    )
  })

  it('keeps duplicates, operands, uncertain regions and unproved TOML literal', () => {
    for (const text of [
      '-m old --model new',
      '-m old -m old',
      '-m old -c model=new',
      '-c model=42',
      '-c model=true',
      `-c 'model="foo"'`,
      '-- --model other',
      '--new-unknown-option --model other',
      '--model'
    ]) {
      expect(load('codex', text), text).toEqual({ userArgs: text, choices: {} })
    }
    for (const text of [
      '--append-system-prompt "--model=other"',
      '--system-prompt "--model sonnet"',
      '--model op\\ us',
      "--model 'opus'"
    ]) {
      expect(load('claude', text), text).toEqual({ userArgs: text, choices: {} })
    }
    expect(load('codex', '-m old --model new -c model_reasoning_effort=high')).toEqual({
      userArgs: '-m old --model new',
      choices: { options: { effort: 'high' } }
    })
  })

  it('distinguishes load conflicts, deliberate edits and independent option removal', () => {
    const input = {
      agent: 'claude' as const,
      userArgs: '--model sonnet --effort high',
      choices: { model: 'opus', options: { effort: 'high' } },
      keys
    }
    expect(reconcileAgentChoiceArgs({ ...input, mode: 'load' })).toEqual({
      userArgs: '--model sonnet',
      choices: input.choices
    })
    expect(reconcileAgentChoiceArgs({ ...input, mode: 'arguments-edit' }).choices.model).toBe(
      'sonnet'
    )
    expect(
      reconcileAgentChoiceArgs({ ...input, mode: 'choice-edit', patch: { model: null } })
    ).toEqual({
      userArgs: '--model sonnet',
      choices: { options: { effort: 'high' } }
    })
    expect(
      reconcileAgentChoiceArgs({
        ...input,
        userArgs: '--model opus --effort high',
        mode: 'choice-edit',
        patch: { model: null }
      })
    ).toEqual({ userArgs: '', choices: { options: { effort: 'high' } } })
  })

  it('reconciles unpatched dirty choices and recomposes generated model options', () => {
    expect(
      reconcileAgentChoiceArgs({
        agent: 'claude',
        userArgs: '--model opus --effort low --verbose',
        choices: { model: 'sonnet', options: { effort: 'high' } },
        keys,
        mode: 'choice-edit',
        patch: { permissionMode: 'ask' }
      })
    ).toEqual({
      userArgs: '--verbose',
      choices: {
        model: 'opus',
        options: { effort: 'low' },
        permissionMode: 'ask'
      }
    })
    expect(
      reconcileAgentChoiceArgs({
        agent: 'claude',
        userArgs: '',
        choices: { model: 'opus', options: { effort: 'high' } },
        keys,
        mode: 'choice-edit',
        patch: { model: 'haiku' }
      }).choices
    ).toEqual({ model: 'haiku' })
    const choices = { model: 'claude-opus-4-8', options: { thinking: 'true', effort: 'high' } }
    const next = reconcileAgentChoiceArgs({
      agent: 'cursor',
      userArgs: '--model claude-opus-4-8-thinking-high --verbose',
      choices,
      keys: new Set(['model', 'thinking', 'effort']),
      mode: 'choice-edit',
      patch: { options: { effort: null } }
    })
    expect(next).toEqual({
      userArgs: '--verbose',
      choices: {
        model: choices.model,
        options: { thinking: 'true' }
      }
    })
    expect(
      projectAgentLaunchProfile(
        'cursor',
        { agentPermissionDefault: 'own' },
        {
          target: 'terminal',
          ...next
        }
      ).args
    ).toBe('--model claude-opus-4-8-thinking --verbose')
  })

  it('does not revive remembered model/options when raw text defeats a yielding layer', () => {
    const input = {
      agent: 'claude' as const,
      remembered: { model: 'sonnet', options: { effort: 'high' } },
      action: { permissionMode: 'ask' as const },
      argumentOwner: 'launch' as const,
      launchPreferencesYieldToAgentArgs: true
    }
    expect(resolveAgentChoiceLayers({ ...input, userArgs: '--model haiku' })).toEqual({
      permissionMode: 'ask'
    })
    expect(resolveAgentChoiceLayers({ ...input, userArgs: '--effort medium' })).toEqual({
      model: 'sonnet',
      permissionMode: 'ask'
    })
    expect(
      resolveAgentChoiceLayers({ ...input, userArgs: '--model haiku', explicit: { model: 'opus' } })
    ).toEqual({ model: 'opus', permissionMode: 'ask' })
  })

  it('resolves raw inheritance before projecting and never imports another model’s options', () => {
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        defaults: { model: 'sonnet' },
        action: { model: 'opus' },
        userArgs: '--append-system-prompt hello',
        argumentOwner: 'launch',
        launchPreferencesYieldToAgentArgs: true
      })
    ).toEqual({ model: 'opus' })
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        remembered: { model: 'sonnet', options: { effort: 'high' } },
        explicit: { model: 'opus' },
        argumentOwner: 'defaults'
      })
    ).toEqual({ model: 'opus' })
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        remembered: { model: 'sonnet' },
        defaults: { options: { effort: 'high' } },
        argumentOwner: 'defaults'
      })
    ).toEqual({ model: 'sonnet', options: { effort: 'high' } })
    expect(
      projectAgentLaunchProfile(
        'claude',
        { agentPermissionDefault: 'ask' },
        { target: 'terminal', choices: { options: { effort: 'high' } }, userArgs: '' }
      ).args
    ).toContain('--effort')
    expect(
      projectAgentLaunchProfile(
        'claude',
        { agentPermissionDefault: 'ask' },
        { target: 'structured', choices: { model: 'opus' }, userArgs: '' }
      )
    ).toEqual({ args: '', choices: { model: 'opus', permissionMode: 'ask' } })
    expect(agentLaunchNeedsPreparedCommand('codex', { model: 'unlisted', effort: 'high' })).toBe(
      false
    )
  })
})

it('adds one Claude settings carrier only for deliberate Fast, including explicit off', () => {
  for (const value of ['true', 'false']) {
    const launch = projectAgentLaunchProfile('claude', undefined, {
      target: 'terminal',
      userArgs: '--add-dir docs',
      choices: { options: { fastMode: value } }
    })
    expect(launch.args).toContain(`"fastMode":${value}`)
    expect(launch.args.match(/--settings/g)).toHaveLength(1)
  }
  expect(
    projectAgentLaunchProfile('claude', undefined, {
      target: 'terminal',
      userArgs: '--add-dir docs',
      choices: { model: 'opus' }
    }).args
  ).not.toContain('--settings')
})

it('edits only the last inline Claude settings object and never unshadows earlier settings on removal', () => {
  const earlier = `--settings '{"language":"french"}'`
  const effective = '{"__proto__":{"unchanged":1},"env":{"A":"B"},"fastMode":false}'
  const text = `${earlier} --settings '${effective}' --add-dir docs`
  const launch = projectAgentLaunchProfile('claude', undefined, {
    target: 'terminal',
    userArgs: text,
    choices: { options: { fastMode: 'true' } }
  })
  const parsed = tokenizeStartupCommand(launch.args, 'posix')
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) {
    throw new Error('invalid compiled arguments')
  }
  const objects = parsed.tokens
    .filter((_, index) => parsed.tokens[index - 1] === '--settings')
    .map((value) => JSON.parse(value))
  expect(objects).toEqual([{ language: 'french' }, JSON.parse(effective.replace('false', 'true'))])
  const analysis = choiceArgs.analyzeAgentChoiceArgs(
    'claude',
    `${earlier} --settings '{"fastMode":true}'`
  )
  const removed = analysis.cut(analysis.occurrences.filter((item) => item.key === 'fastMode'))
  expect(removed).toBe(`${earlier} --settings '{}'`)
  const shadowed = choiceArgs.analyzeAgentChoiceArgs(
    'claude',
    `--settings '{"fastMode":true}' --settings '{}'`
  )
  expect(shadowed.occurrences.filter((item) => item.key === 'fastMode')).toEqual([])
})

it('leaves effective file and unparseable Claude settings literal and never reports Fast applied', () => {
  for (const text of [
    `--settings '{"fastMode":true}' --settings './file with spaces.json'`,
    `--settings '{"language":"french"}' --settings '{broken'`
  ]) {
    const launch = projectAgentLaunchProfile('claude', undefined, {
      target: 'terminal',
      userArgs: text,
      choices: { options: { fastMode: 'true' } }
    })
    expect(launch.args).toBe(text)
    const analysis = choiceArgs.analyzeAgentChoiceArgs('claude', text)
    expect(analysis.opaqueKeys.has('fastMode')).toBe(true)
    expect(analysis.occurrences.filter((item) => item.key === 'fastMode')).toEqual([])
  }
})

it('round-trips arbitrary host-owned Codex tier ids through the common config carrier without a release list', () => {
  const userArgs = '-c service_tier=account_fast_v9 --add-dir docs'
  const read = reconcileAgentChoiceArgs({
    agent: 'codex',
    userArgs,
    choices: {},
    mode: 'arguments-edit',
    keys: new Set(['serviceTier'])
  })
  expect(read).toEqual({
    userArgs: '--add-dir docs',
    choices: { options: { serviceTier: 'account_fast_v9' } }
  })
  const launch = projectAgentLaunchProfile('codex', undefined, {
    target: 'terminal',
    userArgs: read.userArgs,
    choices: read.choices
  })
  expect(launch.args).toBe('-c service_tier=account_fast_v9 --add-dir docs')
})

it.each([
  ['claude', '--add-dir /tmp/😀 --model "opus" --effort high -- tail'],
  ['claude', '--add-dir /tmp --model=opus --effort=high -- tail'],
  ['codex', '--search -m o3 -c model_reasoning_effort=high -- tail'],
  ['codex', '--search -c model=o3 -- tail'],
  ['cursor', '--model claude-opus-4-8-thinking-high --verbose']
] as const)(
  'preserves the current %s literal document spelling, gaps and edit lifetime: %s',
  (agent, raw) => {
    const input: SourceControlActionRecipe = { agentId: agent, agentArgs: raw }
    const recipe = liftActionPermissionArgs(input)
    if (raw.includes('😀')) {
      expect(recipe.argumentChoices?.nodes.map((node) => node.at)).toEqual([18, 19])
    }
    expect(recipe.launchPreferences).toBeUndefined()
    expect(recipe.argumentChoices?.syntaxAgent).toBe(agent)
    expect(recipe.argumentChoices?.nodes.map((node) => node.text)).toEqual(
      agent === 'claude'
        ? raw.includes('=')
          ? ['--model=opus', '--effort=high']
          : ['--model "opus"', '--effort high']
        : agent === 'cursor'
          ? ['--model claude-opus-4-8-thinking-high']
          : raw.includes('model=o3')
            ? ['-c model=o3']
            : ['-m o3', '-c model_reasoning_effort=high']
    )
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      const original = tokenizeStartupCommand(raw, shell)
      const lowered = tokenizeStartupCommand(lowerActionArgumentChoices(recipe) ?? '', shell)
      expect(original.ok && lowered.ok).toBe(true)
      if (!original.ok || !lowered.ok) {
        throw new Error('Expected common syntax')
      }
      expect(lowered.tokens).toEqual(original.tokens)
    }
    expect(normalizeSourceControlActionRecipe(recipe)).toEqual(recipe)
    const padded = {
      ...recipe,
      agentArgs: `   ${recipe.agentArgs}   `,
      argumentChoices: recipe.argumentChoices && {
        ...recipe.argumentChoices,
        nodes: recipe.argumentChoices.nodes.map((node) => ({ ...node, at: node.at + 3 }))
      }
    }
    expect(readSourceControlActionDefault({ fixChecks: padded }, 'fixChecks')).toEqual(recipe)
    expect(
      transportActionArgumentChoices(recipe, 'unclosed "')?.nodes.map((node) => node.at)
    ).toEqual(recipe.argumentChoices?.nodes.map(() => 0))
    const text = `prefix ${recipe.agentArgs}`
    const edited = {
      ...recipe,
      agentArgs: text,
      argumentChoices: transportActionArgumentChoices(recipe, text)
    }
    expect(edited.argumentChoices?.nodes.map((node) => node.at)).toEqual(
      recipe.argumentChoices?.nodes.map((node) => (node.at === 0 ? 0 : node.at + 7))
    )
    const selected = {
      model:
        agent === 'claude' ? 'opus' : agent === 'cursor' ? 'claude-opus-4-8-thinking-high' : 'o3',
      options: { effort: 'high' }
    }
    const removed = editActionArgumentChoices(edited, agent, selected, { model: null }, text)
    expect(
      (removed.argumentChoices?.nodes ?? []).some(
        (node) => readActionArgumentNode(agent, node.text)?.key === 'model'
      )
    ).toBe(false)
    expect(liftActionPermissionArgs({ ...removed, agentId: agent }).argumentChoices).toEqual(
      removed.argumentChoices
    )
  }
)

it('moves an anchor out of a replaced token and rejects malformed document atoms', () => {
  const recipe = liftActionPermissionArgs<SourceControlActionRecipe>({
    agentId: 'claude' as const,
    agentArgs: '--add-dir /tmp --model opus -- tail'
  })
  const agentArgs = '--add-dir /tmpX -- tail'
  const edited = {
    ...recipe,
    agentArgs,
    argumentChoices: transportActionArgumentChoices(recipe, agentArgs)
  }
  expect(edited.argumentChoices?.nodes).toEqual([{ at: 15, text: '--model opus' }])
  expect(tokenizeStartupCommand(lowerActionArgumentChoices(edited) ?? '', 'posix')).toMatchObject({
    ok: true,
    tokens: ['--add-dir', '/tmpX', '--model', 'opus', '--', 'tail']
  })
  const trailing = liftActionPermissionArgs<SourceControlActionRecipe>({
    agentId: 'codex' as const,
    agentArgs: '--search -m o3 --search -c model_reasoning_effort=high'
  })
  const trailingArgs = `${trailing.agentArgs}^ `
  const trailingChoices = transportActionArgumentChoices(trailing, trailingArgs)
  expect(trailing.agentArgs).toBe('--search  --search')
  expect(trailing.argumentChoices?.nodes.map((node) => node.at)).toEqual([9, 18])
  expect(trailingChoices?.nodes.map((node) => node.at)).toEqual([0, 0])
  const canonical = { ...trailing, agentArgs: trailingArgs, argumentChoices: trailingChoices }
  expect(trailingChoices?.nodes.map((node) => node.text)).toEqual([
    '-m o3',
    '-c model_reasoning_effort=high'
  ])
  expect(canonical.agentArgs).toBe('--search  --search^ ')
  const normalized = normalizeSourceControlActionRecipe(canonical)
  expect(normalized).toEqual(canonical)
  expect(normalizeSourceControlActionRecipe(normalized)).toEqual(normalized)
  for (const document of [canonical, normalized!]) {
    expect(lowerActionArgumentChoices(document)).toBe(
      '-m o3  -c model_reasoning_effort=high --search  --search^'
    )
  }
  for (const nodes of [
    [{ at: -1, text: '--model opus' }],
    [{ at: 0.5, text: '--model opus' }],
    [
      { at: 1, text: '--model opus' },
      { at: 0, text: '--effort high' }
    ],
    [
      { at: 0, text: '--model opus' },
      { at: 0, text: '--model sonnet' }
    ],
    [{ at: 0, text: '--model opus --verbose' }],
    [{ at: 0, text: '--permission-mode auto' }]
  ]) {
    expect(() =>
      normalizeSourceControlActionRecipe({
        agentId: 'claude',
        agentArgs: '--verbose',
        argumentChoices: { syntaxAgent: 'claude', nodes }
      })
    ).toThrow(/(?:Invalid|Duplicate) action argument choice/)
  }
})

it('retires model-dependent live effort when raw Model changes, while preserving permission and independent removal', () => {
  const recipe = liftActionPermissionArgs<SourceControlActionRecipe>({
    agentId: 'claude' as const,
    agentArgs: '--model opus --effort high',
    launchPreferences: { agentId: 'claude' as const, permissionMode: 'ask' as const }
  })
  const changed = liftActionPermissionArgs({ ...recipe, agentArgs: '--model haiku' }, true)
  expect(changed.argumentChoices?.nodes).toEqual([{ at: 0, text: '--model haiku' }])
  expect(changed.launchPreferences).toEqual({ agentId: 'claude', permissionMode: 'ask' })
  const removed = editActionArgumentChoices(
    recipe,
    'claude',
    { model: 'opus', options: { effort: 'high' }, permissionMode: 'ask' },
    { model: null },
    ''
  )
  expect(removed.argumentChoices?.nodes).toEqual([{ at: 0, text: '--effort high' }])
  expect(removed.launchPreferences).toEqual({
    agentId: 'claude',
    permissionMode: 'ask',
    modelSelection: { base: 'default', model: { agentId: 'claude', value: null } }
  })
})

it('bounds real raw-edit transport across invalid, divergent, exhausted and two-node boundaries', () => {
  const tokenize = startupShell.tokenizeStartupCommand
  let reads = 0
  let population = 0
  let outcomes: boolean[] = []
  const spy = vi.spyOn(startupShell, 'tokenizeStartupCommand').mockImplementation((text, shell) => {
    const parsed = tokenize(text, shell)
    outcomes.push(parsed.ok)
    if (!parsed.ok) {
      return parsed
    }
    population += parsed.spans.length
    return {
      ...parsed,
      spans: parsed.spans.map((span) =>
        Object.defineProperties(
          { ...span },
          {
            start: {
              get: () => {
                reads++
                return span.start
              }
            },
            end: {
              get: () => {
                reads++
                return span.end
              }
            }
          }
        )
      )
    }
  })
  const measure = (
    recipe: SourceControlActionRecipe,
    next: string,
    expected: number[],
    lower: string
  ) => {
    reads = population = 0
    outcomes = []
    const document = transportActionArgumentChoices(recipe, next)
    const work = { reads, population, outcomes: [...outcomes], nodes: document!.nodes.length }
    expect(document?.syntaxAgent).toBe('codex')
    expect(document?.nodes.map((node) => node.at)).toEqual(expected)
    expect(document?.nodes.map((node) => node.text)).toEqual(
      recipe.argumentChoices?.nodes.map((node) => node.text)
    )
    expect(outcomes).toHaveLength(3)
    expect(reads).toBeLessThanOrEqual(20 * work.nodes * (population + 1))
    expect(lowerActionArgumentChoices({ agentArgs: next, argumentChoices: document })).toBe(lower)
    return work
  }
  try {
    const invalid: ReturnType<typeof measure>[] = []
    const valid: ReturnType<typeof measure>[] = []
    const short = liftActionPermissionArgs<SourceControlActionRecipe>({
      agentId: 'codex' as const,
      agentArgs: '--search -m o3'
    })
    expect(short.agentArgs).toBe('--search')
    expect(short.argumentChoices?.nodes).toEqual([{ at: 8, text: '-m o3' }])
    for (const n of [128, 1280]) {
      const recipe = liftActionPermissionArgs<SourceControlActionRecipe>({
        agentId: 'codex' as const,
        agentArgs: `--search -m o3 --search ${'--search '.repeat(n)}`
      })
      expect(recipe.agentArgs).toBe(`--search  --search ${'--search '.repeat(n).trim()}`)
      expect(recipe.argumentChoices?.nodes).toEqual([{ at: 9, text: '-m o3' }])
      const next = String.fromCharCode(92, 34, 32) + recipe.agentArgs
      const failed = measure(recipe, next, [0], `-m o3 ${next}`)
      expect(failed.outcomes).toEqual([true, false, false])
      expect(failed.population).toBeGreaterThan(n)
      invalid.push(failed)
      const divergent = `${'--search^ '.repeat(n)}tail`
      const passed = measure(short, divergent, [divergent.length], `${divergent} -m o3`)
      expect(passed.outcomes).toEqual([true, true, true])
      expect(passed.population).toBeGreaterThan(n)
      expect(passed.reads).toBeGreaterThan(n)
      valid.push(passed)
    }
    measure(short, '--search^ ', [0], '-m o3 --search^')
    expect(invalid[1].reads).toBeLessThanOrEqual(12 * (invalid[0].reads + 1))
    expect(valid[1].reads).toBeLessThanOrEqual(12 * valid[0].reads)
    const pair = liftActionPermissionArgs({
      agentId: 'codex' as const,
      agentArgs: '--search -m o3 --search -c model_reasoning_effort=high'
    })
    const two = measure(
      pair,
      `${pair.agentArgs}^ `,
      [0, 0],
      '-m o3  -c model_reasoning_effort=high --search  --search^'
    )
    expect(two.reads).toBeGreaterThan(0)
    process.stdout.write(
      `${JSON.stringify({ metric: 'raw-edit-transport', invalid, valid, two })}\n`
    )
  } finally {
    spy.mockRestore()
  }
})

it('keeps settings equals, operand and terminator ownership at the shared analyzer boundary', () => {
  const text = `--settings='{"fastMode":true,"shadowed":1}' --settings='{"fastMode":false,"env":{"fastMode":true}}' --add-dir docs`
  const analysis = choiceArgs.analyzeAgentChoiceArgs('claude', text)
  const fast = analysis.occurrences.filter((item) => item.key === 'fastMode')
  expect(fast).toMatchObject([{ value: 'false', owned: false, lift: false }])
  expect(
    reconcileAgentChoiceArgs({
      agent: 'claude',
      userArgs: text,
      choices: {},
      mode: 'arguments-edit',
      keys: new Set(['fastMode'])
    })
  ).toEqual({ userArgs: text, choices: {} })
  const cut = analysis.cut(fast)!
  for (const shell of ['posix', 'powershell', 'cmd'] as const) {
    const parsed = tokenizeStartupCommand(cut, shell)
    expect(parsed).toMatchObject({
      ok: true,
      tokens: [
        '--settings={"fastMode":true,"shadowed":1}',
        '--settings',
        '{"env":{"fastMode":true}}',
        '--add-dir',
        'docs'
      ]
    })
  }
  for (const raw of [
    `-- --settings '{"fastMode":true}'`,
    `--model --settings '{"fastMode":true}'`,
    `--settings '{broken`
  ]) {
    const result = choiceArgs.analyzeAgentChoiceArgs('claude', raw)
    expect(result.occurrences.filter((item) => item.key === 'fastMode')).toEqual([])
    expect(result.cut([])).toBe(raw)
  }
})

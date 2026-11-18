import { expect, it } from 'vitest'

it('decodes CLI TOML strings and emits type-equivalent config scalars', async () => {
  const { agentChoiceConfigString, agentChoiceCliApply } = await import('./agent-choice-cli-apply')
  const { parse } = await import('smol-toml')
  const apply = agentChoiceCliApply(
    'codex',
    [{ kind: 'config', names: ['-c'], key: 'model_reasoning_effort', lift: 'codex-bare-string' }],
    '-c'
  )
  for (const value of [
    'high',
    'future_effort',
    'true',
    'false',
    '42',
    'inf',
    'some-model',
    'a"b'
  ]) {
    expect(agentChoiceConfigString(JSON.stringify(value))).toBe(value)
    const emitted = apply.launchArgs!(value)[1].split('=').slice(1).join('=')
    expect(agentChoiceConfigString(emitted)).toBe(value)
    let decoded: unknown
    try {
      decoded = parse(`value=${emitted}`).value
    } catch {
      decoded = emitted
    }
    expect(decoded).toBe(value)
  }
  for (const value of [
    'true',
    'false',
    '42',
    '1.0',
    '["high"]',
    '{value="high"}',
    '"high"\nother="lost"'
  ]) {
    expect(agentChoiceConfigString(value)).toBeUndefined()
  }
})

it('supports bare flag options for antigravity without consuming following tokens or leaking into chats', async () => {
  const { agentChoiceCliApply } = await import('./agent-choice-cli-apply')
  const { analyzeChoiceArgs } = await import('./agent-choice-args-analysis')
  const { reconcileAgentChoiceArgs } = await import('./agent-choice-reconciliation')
  const { permissionOptionInventory, analyzeAgentChoiceWords } =
    await import('../permissions/agent-permission-args')
  const { resolveAgentSessionOptionLaunch, hasIndependentAgentLaunchOptions } =
    await import('../../agent-session/options/launch/agent-session-option-launch')
  const { agentRequiredValueOptions } =
    await import('../../agent-session/options/launch/agent-session-option-agent-args')
  const { AGENT_LAUNCH_CHOICE_KEYS } = await import('./agent-launch-choices')
  const { ANTIGRAVITY_SESSION_OPTION_CATALOG } =
    await import('../../agent-session/options/catalog-providers/agent-session-option-catalog-antigravity')
  const { structuredAgentSessionOptionCatalog } =
    await import('../../agent-session/options/structured-agent-session-options')

  expect(agentRequiredValueOptions('antigravity')).toContain('--project')

  const apply = agentChoiceCliApply(
    'antigravity',
    [{ kind: 'flag', names: ['--remote-agent'], lift: 'bare' }],
    '--remote-agent'
  )
  expect(apply.launchArgs!(true)).toEqual(['--remote-agent'])
  expect(apply.launchArgs!('true')).toEqual(['--remote-agent'])
  expect(apply.launchArgs!(false)).toEqual([])
  expect(apply.launchArgs!('false')).toEqual([])
  expect(apply.removeAgentArgs!(['--remote-agent', 'keep-me', '--project', 'p1'])).toEqual([
    'keep-me',
    '--project',
    'p1'
  ])

  const inventory = permissionOptionInventory('antigravity')
  expect(inventory.switches.has('--remote-agent')).toBe(true)
  expect(inventory.values.has('--remote-agent')).toBe(false)

  const wordAnalysis = analyzeAgentChoiceWords('antigravity', [
    '--remote-agent',
    '--project',
    '-my-proj',
    '--effort',
    'xhigh'
  ])
  expect(wordAnalysis.roles).toEqual([
    'option:--remote-agent',
    'option:--project',
    'value:--project',
    'option:--effort',
    'value:--effort'
  ])

  const analyzed = analyzeChoiceArgs(
    'antigravity',
    '--remote-agent --remote-control --effort max --project -my-proj',
    ['posix', 'powershell', 'cmd']
  )
  expect(analyzed.occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: 'remoteAgent',
        value: 'true',
        valueType: 'boolean',
        lift: true
      }),
      expect.objectContaining({
        key: 'remoteControl',
        value: 'true',
        valueType: 'boolean',
        lift: true
      }),
      expect.objectContaining({ key: 'effort', value: 'max', lift: true })
    ])
  )

  const inlineIgnored = analyzeChoiceArgs('antigravity', '--remote-agent=yes', ['posix'])
  expect(inlineIgnored.occurrences.some((entry) => entry.key === 'remoteAgent')).toBe(false)

  const reconciled = reconcileAgentChoiceArgs({
    agent: 'antigravity',
    userArgs: '--remote-agent --effort xhigh --project -my-proj',
    choices: {},
    mode: 'load',
    keys: AGENT_LAUNCH_CHOICE_KEYS
  })
  expect(reconciled.userArgs).toBe('--project -my-proj')
  expect(reconciled.choices).toEqual({
    options: { remoteAgent: 'true', effort: 'xhigh' }
  })

  const launch = resolveAgentSessionOptionLaunch('antigravity', {
    model: 'gemini-3-pro',
    effort: 'xhigh',
    remoteAgent: 'true'
  })
  expect(launch.args).toEqual(['--model', 'gemini-3-pro', '--effort', 'xhigh', '--remote-agent'])
  expect(hasIndependentAgentLaunchOptions('antigravity', launch.appliedValues)).toBe(true)

  const defaultLaunch = resolveAgentSessionOptionLaunch('antigravity', {
    model: 'gemini-3-pro',
    remoteAgent: 'false'
  })
  expect(defaultLaunch.args).toEqual(['--model', 'gemini-3-pro'])
  expect(hasIndependentAgentLaunchOptions('antigravity', defaultLaunch.appliedValues)).toBe(false)

  const chatCatalog = structuredAgentSessionOptionCatalog(
    ANTIGRAVITY_SESSION_OPTION_CATALOG,
    {
      models: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro', isDefault: true, efforts: [] }],
      current: { model: 'unlisted-model' }
    },
    'antigravity'
  )
  const unlisted = chatCatalog.models.find((model) => model.id === 'unlisted-model')!
  expect(unlisted.options.map((option) => option.id)).toEqual(['effort'])
})

// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../../../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit
} from '../../../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import { agentPickerPanelArguments } from '../../../../../../shared/agent-launch/picker/agent-launch-picker-arguments'
import { mockCreateTab, queuedStartups, store } from './launch-agent-in-new-tab-test-fixture'
import { fetchCodexModelCatalogListing } from '../../../codex-model-catalog-reader-test-fixture'

it('passes the recorded Codex catalog tier and approval/sandbox policy through the common reader, picker and real compiler', async () => {
  const { default: capture } =
    await import('../../../../../../shared/fixtures/agent-picker-cli-recordings.json')
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  const listing = await fetchCodexModelCatalogListing({
    connection: { request: vi.fn().mockResolvedValue(capture.modelList) }
  })
  const model = listing.models[0]
  const tier = model.serviceTiers![0].value
  expect(capture.policy.sandbox.type).toBe('workspaceWrite')
  const raw = `-a ${capture.policy.approvalPolicy} -s workspace-write -c approvals_reviewer=${capture.policy.approvalsReviewer}`
  const entry: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'chat' }],
    surfaces: ['chat', 'terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    arguments: `${raw} --add-dir docs`,
    catalog: { origin: 'probe', fetchedAt: 1, models: listing.models }
  }
  const selected = applyAgentPickerEdit(entry, agentPickerDraft(entry), {
    kind: 'speed',
    key: 'serviceTier',
    value: tier,
    model: model.id
  })
  const view = agentPickerPanelArguments(entry, selected)
  expect(view.permission).toBeDefined()
  const edited = acceptAgentPickerArguments(
    entry,
    applyAgentPickerEdit(entry, selected, {
      kind: 'arguments',
      text: '--add-dir src'
    })
  )
  for (const next of [selected, edited]) {
    mockCreateTab.mockClear()
    const inputs = agentPickerLaunchInputs({ ...next, surface: 'terminal' }, entry)
    launchAgentInNewTab({
      requestId: 'recorded-policy',
      agent: 'codex',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      ...inputs
    })
    expect(queuedStartups()[0]?.command).toContain(`'service_tier=${tier}'`)
    expect(queuedStartups()[0]?.command).toContain("'-a' 'on-request' '-s' 'workspace-write'")
    expect(
      agentPickerLaunchInputs({ ...next, surface: 'chat' }, entry).sessionOptions?.serviceTier
    ).toBe(tier)
  }
  const standard = acceptAgentPickerArguments(
    entry,
    applyAgentPickerEdit(entry, selected, {
      kind: 'arguments',
      text: '-c service_tier=default --add-dir src'
    })
  )
  expect(standard).toMatchObject({ choices: { options: { serviceTier: 'default' } } })
  expect(
    agentPickerLaunchInputs({ ...standard, surface: 'chat' }, entry).sessionOptions?.serviceTier
  ).toBe('default')
  expect(agentPickerLaunchInputs({ ...standard, surface: 'terminal' }, entry).agentArgs).toContain(
    'service_tier=default'
  )
  expect(view.choices.options?.serviceTier).toBe(tier)
  const removed = applyAgentPickerEdit(entry, selected, { kind: 'remove-chip', key: 'serviceTier' })
  expect(agentPickerPanelArguments(entry, removed).choices.options?.serviceTier).toBe('default')
})

it('conserves quoted Codex string sources through common acceptance and the terminal compiler', async () => {
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  const { tokenizeStartupCommand } =
    await import('../../../../../../shared/agent-launch/startup/tui-agent-startup-shell')
  const { agentChoiceConfigString } =
    await import('../../../../../../shared/agent-launch/choices/agent-choice-cli-apply')
  const own: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'cli' }],
    surfaces: ['chat', 'terminal'],
    defaultSurface: 'terminal',
    terminal: { permissionMode: 'own' },
    structured: {},
    arguments: '',
    catalog: { origin: 'unknown' }
  }
  for (const [key, scalar] of [
    ['model', 'some-model'],
    ['model', 'true'],
    ['model', '42'],
    ['model', 'a"b'],
    ['model_reasoning_effort', 'high'],
    ['model_reasoning_effort', 'future_effort']
  ]) {
    const operand = `${key}=${JSON.stringify(scalar)}`
    const raw = `-c '${operand}' --search`
    const draft = acceptAgentPickerArguments(
      own,
      applyAgentPickerEdit(own, agentPickerDraft(own), { kind: 'arguments', text: raw })
    )
    const semanticKey = key === 'model' ? 'model' : 'effort'
    expect(agentPickerPanelArguments(own, draft).text).toBe('--search')
    expect(
      agentPickerLaunchInputs({ ...draft, surface: 'chat' }, own).chatSessionOptions?.[semanticKey]
    ).toBe(scalar)
    for (const command of ['codex', 'cx']) {
      store.settings.agentCmdOverrides = { codex: command }
      mockCreateTab.mockClear()
      launchAgentInNewTab({
        requestId: 'quoted-string-source',
        agent: 'codex',
        worktreeId: 'wt-1',
        requestedSurface: 'terminal',
        ...agentPickerLaunchInputs(draft, own)
      })
      const startup = queuedStartups()[0]
      expect(startup?.launchConfig?.agentArgs).toContain(raw)
      const compiled = tokenizeStartupCommand(startup?.command ?? '', 'posix')
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) {
        throw new Error('Expected valid terminal startup')
      }
      expect(compiled.tokens[0]).toBe(command)
      const operands = compiled.tokens.filter((token) => token.startsWith(`${key}=`))
      expect(operands).toEqual([operand])
      expect(agentChoiceConfigString(operands[0].slice(key.length + 1))).toBe(scalar)
    }
  }
})

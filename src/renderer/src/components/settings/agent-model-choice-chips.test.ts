import { expect, it, vi } from 'vitest'
import { agentModelChoiceChips } from './agent-model-choice-chips'
import * as profile from '../../../../shared/agent-launch-profile'
import * as analyzer from '../../../../shared/agent-choice-args'

it('projects the whole selection once and removes actual independent or composed carriers', () => {
  const project = vi.spyOn(profile, 'projectAgentLaunchProfile')
  const analyze = vi.spyOn(analyzer, 'analyzeAgentChoiceArgs')
  const remove = vi.fn((_patch, text: string) => text)
  try {
    const codex = agentModelChoiceChips(
      'codex',
      'Codex',
      {
        model: 'gpt-5.6-sol',
        options: { effort: 'future_effort', serviceTier: 'fast' },
        permissionMode: 'ask'
      },
      remove
    )
    expect(project).toHaveBeenCalledOnce()
    expect(analyze).toHaveBeenCalledOnce()
    expect(codex.map(({ key, flag }) => ({ key, flag }))).toEqual([
      { key: 'permissionMode', flag: '-a on-request -s read-only -c approvals_reviewer=user' },
      { key: 'model', flag: '-m gpt-5.6-sol' },
      { key: 'effort', flag: '-c model_reasoning_effort=future_effort' },
      { key: 'serviceTier', flag: '-c service_tier=fast' }
    ])
    codex.find((chip) => chip.key === 'effort')!.onRemove('--search')
    expect(remove).toHaveBeenLastCalledWith({ options: { effort: null } }, '--search')
    const cursor = agentModelChoiceChips(
      'cursor',
      'Cursor',
      { model: 'claude-opus-4-8', options: { effort: 'high', thinking: 'true' } },
      remove
    )
    expect(cursor.map(({ key, flag }) => ({ key, flag }))).toEqual([
      { key: 'model', flag: '--model claude-opus-4-8-thinking-high' }
    ])
    cursor[0].onRemove('--verbose')
    expect(remove).toHaveBeenLastCalledWith({ model: null }, '--verbose')
    expect(
      agentModelChoiceChips(
        'openclaw',
        'OpenClaw',
        { model: 'native-model', options: { effort: 'high' } },
        remove
      )
    ).toEqual([])
    for (const fastMode of ['true', 'false']) {
      const chips = agentModelChoiceChips(
        'claude',
        'Claude',
        { model: 'sonnet', options: { fastMode } },
        remove
      )
      expect(chips.map((chip) => chip.flag)).toEqual([
        '--model sonnet',
        `--settings '{"fastMode":${fastMode}}'`
      ])
      expect(project.mock.results.at(-1)?.value.launch).toEqual({
        args: [
          '--model',
          'sonnet',
          '--settings',
          JSON.stringify({ fastMode: fastMode === 'true' })
        ],
        appliedValues: { model: 'sonnet', fastMode: fastMode === 'true' }
      })
    }
    expect(
      agentModelChoiceChips('codex', 'Codex', { options: { serviceTier: 'default' } }, remove).map(
        (chip) => chip.flag
      )
    ).toEqual(['-c service_tier=default'])
  } finally {
    project.mockRestore()
    analyze.mockRestore()
  }
})

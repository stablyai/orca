import { describe, expect, it } from 'vitest'
import { agentLaunchSetupModelRows } from './agent-launch-setup-option-rows'
import type { AgentPickerModel } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const models: AgentPickerModel[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isDefault: false, efforts: [] },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', isDefault: false, efforts: [], isLegacy: true },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', isDefault: false, efforts: [], isLegacy: true }
]
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)

describe('agentLaunchSetupModelRows', () => {
  it('keeps rows in place when the pick changes while the list is open', () => {
    for (const current of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol']) {
      const { rows, legacyRows, legacyCount } = agentLaunchSetupModelRows(
        models,
        current,
        '',
        true,
        false
      )
      expect(ids(rows)).toEqual(['gpt-6.1-sol'])
      expect(ids(legacyRows)).toEqual(['gpt-6-sol', 'gpt-5.6-sol'])
      expect(legacyCount).toBe(2)
    }
  })

  it('starts on a current legacy row only while its section is shown', () => {
    expect(agentLaunchSetupModelRows(models, 'gpt-6-sol', '', true, false).start).toBe('gpt-6-sol')
    expect(agentLaunchSetupModelRows(models, 'gpt-6-sol', '', false, false).start).toBeUndefined()
  })

  it('lists a hidden short name only while it is the current choice', () => {
    const claude: AgentPickerModel[] = [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', isDefault: true, efforts: [] },
      { id: 'opus', label: 'Opus', isDefault: false, efforts: [], hidden: true }
    ]
    expect(
      ids(agentLaunchSetupModelRows(claude, 'claude-opus-5-5', '', false, false).rows)
    ).toEqual(['claude-opus-5-5'])
    const onAlias = agentLaunchSetupModelRows(claude, 'opus', '', false, false)
    expect(ids(onAlias.rows)).toEqual(['claude-opus-5-5', 'opus'])
    expect(onAlias.start).toBe('opus')
  })
})

import { describe, expect, it } from 'vitest'
import { agentLaunchSetupModelRows } from './agent-launch-setup-option-rows'
import type { AgentPickerModel } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const models: AgentPickerModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', isDefault: true, efforts: [] },
  { id: 'opus', label: 'Opus', isDefault: false, efforts: [], hidden: true }
]
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)

describe('agentLaunchSetupModelRows', () => {
  it('lists a hidden short name only while it is current or a search matches it', () => {
    expect(
      ids(agentLaunchSetupModelRows(models, 'claude-opus-5-5', '', false, false).rows)
    ).toEqual(['claude-opus-5-5'])
    const onAlias = agentLaunchSetupModelRows(models, 'opus', '', false, false)
    expect(ids(onAlias.rows)).toEqual(['claude-opus-5-5', 'opus'])
    expect(onAlias.start).toBe('opus')
    expect(ids(agentLaunchSetupModelRows(models, undefined, 'opus', false, false).rows)).toEqual([
      'claude-opus-5-5',
      'opus'
    ])
  })
})

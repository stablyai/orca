import { describe, expect, it } from 'vitest'
import { withAgentPickerCopyEntries } from '../../../../../shared/agent-launch/picker/agent-picker-copy-entries'
import type { AgentPickerEntry } from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  buildAgentPickerLaunchOptions,
  configuredAgentPickerLaunchOption,
  matchingAgentPickerLaunchOptions
} from './tab-agent-launch-options'

const claude: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [{ kind: 'cli', agent: 'claude', executionHostId: 'local', chat: true }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 0,
    models: [
      { id: 'opus', label: 'Opus', isDefault: true, efforts: [{ value: 'high', label: 'High' }] }
    ]
  }
}
const entries = withAgentPickerCopyEntries(
  [claude],
  [{ id: 'claude.claude-code-mode', name: 'Claude Code Mode', agent: 'claude' }],
  ['claude'],
  { agentDefaultSurface: 'terminal' }
)
const copyId = 'claude.claude-code-mode'

describe('agent copies in the new-tab search row', () => {
  it('offers the copy as its own agent result that launches the copy', () => {
    const options = buildAgentPickerLaunchOptions(entries)

    expect(options.map((option) => option.label)).toEqual(['Claude', 'Claude Code Mode'])
    expect(options[1]).toMatchObject({
      agent: 'claude',
      row: { kind: 'cli', copy: { id: copyId } },
      pickerEntry: { copy: { id: copyId } }
    })
  })

  it('keeps the copy on a model setup found by search and on a configured panel launch', () => {
    const setup = matchingAgentPickerLaunchOptions(entries, 'opus').find(
      (option) => option.pickerEntry?.copy
    )

    expect(setup?.row?.copy?.id).toBe(copyId)
    expect(setup?.id).toContain(copyId)
    const configured = configuredAgentPickerLaunchOption(setup!, {
      agent: 'claude',
      surface: 'chat',
      choices: { model: 'opus' }
    })
    expect(configured.row).toMatchObject({ kind: 'chat', copy: { id: copyId } })
  })
})

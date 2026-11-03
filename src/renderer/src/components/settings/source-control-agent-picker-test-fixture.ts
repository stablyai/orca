import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

export const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  ownerKey: 'recipe-test',
  rows: [{ agent: 'claude', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: { permissionMode: 'own' },
  structured: { model: 'sonnet', permissionMode: 'ask' },
  arguments: '--agents-default',
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true },
      { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }
    ]
  }
}

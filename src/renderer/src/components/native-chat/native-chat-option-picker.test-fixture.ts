import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'

export function model(overrides: Partial<SessionOptionDescriptor> = {}): SessionOptionDescriptor {
  return {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: {
      type: 'select',
      currentValue: 'opus',
      choices: [
        { value: 'opus', label: 'Opus 4.8' },
        { value: 'sonnet', label: 'Sonnet 5' }
      ]
    },
    valueSource: 'applied',
    transport: 'catalog',
    settable: true,
    ...overrides
  }
}

const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]

export const effort: SessionOptionDescriptor = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: { type: 'select', currentValue: 'high', choices: EFFORT_CHOICES },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

/** Only selects can truthfully have no current value; booleans require a baseline. */
export const unknownEffort: SessionOptionDescriptor = {
  ...effort,
  kind: { type: 'select', choices: EFFORT_CHOICES },
  valueSource: 'unknown'
}

export const fast: SessionOptionDescriptor = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', currentValue: true },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

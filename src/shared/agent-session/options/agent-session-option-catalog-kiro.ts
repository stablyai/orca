import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'
import type { SessionOptionSelectChoice } from '../../native-chat/input/native-chat-session-options'
import type {
  AgentSessionOptionCatalog,
  CatalogMidSessionApply,
  CatalogOption
} from './agent-session-option-catalog-types'

// Kiro configures effort in its /model panel; `/effort` is deprecated there.
const KIRO_MODEL_PANEL: CatalogMidSessionApply = { kind: 'agent-picker', command: '/model' }

const KIRO_EFFORT_LEVELS: SessionOptionSelectChoice[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

// Levels and defaults each model reports in a fresh kiro-cli 3.1.0 V3 session.
function kiroEffort(defaultValue: 'medium' | 'high', offersNone = false): CatalogOption {
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: offersNone
        ? [{ value: 'none', label: 'None' }, ...KIRO_EFFORT_LEVELS]
        : KIRO_EFFORT_LEVELS,
      defaultValue
    },
    apply: {
      ...agentChoiceCliApply(
        'kiro',
        [{ kind: 'value', names: ['--effort'], lift: 'separate-and-long-equals' }],
        '--effort'
      ),
      midSession: KIRO_MODEL_PANEL
    }
  }
}

export const KIRO_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Account-scoped: seed the current models; chats list the rest from `kiro-cli chat --list-models`.
  models: [
    // Auto picks a model per task and takes no effort level.
    { id: 'auto', label: 'Auto', isDefault: true, options: [] },
    { id: 'claude-opus-5.5', label: 'Claude Opus 5.5', options: [kiroEffort('medium')] },
    { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', options: [kiroEffort('high')] },
    { id: 'claude-haiku-5.5', label: 'Claude Haiku 5.5', options: [kiroEffort('medium')] },
    { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', options: [kiroEffort('high', true)] },
    { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', options: [kiroEffort('high', true)] },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', options: [kiroEffort('high', true)] }
  ],
  // `kiro-cli chat` takes these; Chat applies them as session options since V3 `acp` rejects them.
  modelApply: {
    ...agentChoiceCliApply(
      'kiro',
      [{ kind: 'value', names: ['--model'], lift: 'separate-and-long-equals' }],
      '--model'
    ),
    midSession: KIRO_MODEL_PANEL
  }
}

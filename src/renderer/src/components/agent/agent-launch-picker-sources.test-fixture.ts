import recording from '../../../../main/acp/fixtures/antigravity-v1.4.3-options.json'
import { AcpStructuredOptions } from '../../../../main/acp/options/acp-structured-options'
import { parseAntigravityModels } from '../../../../shared/source-control/ai/generation/commit-message-model-parsers'
import { getCommitMessageAgentCapability } from '../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { cliModelCatalogAnswer } from '@/runtime/native-chat/model-catalogs/model-menu-cli-catalog'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

// Recorded agy 1.4.11 models rows; IDs are protocol operands, including the non-suffix ID.
export const cliOutput =
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6\n'
export const cliResult = {
  success: true as const,
  catalogOrigin: 'probe' as const,
  capability: getCommitMessageAgentCapability('antigravity')!,
  models: parseAntigravityModels(cliOutput).map((row) => ({ ...row, thinkingLevels: [] })),
  defaultModelId: '__text_action_default__'
}

export function sourceEntry(
  defaultSurface: AgentPickerEntry['defaultSurface'] = 'chat'
): AgentPickerEntry {
  const options = new AcpStructuredOptions()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recorded ACP JSON has the protocol's select discriminator values.
  options.adoptSession(
    recording.session as Parameters<AcpStructuredOptions['adoptSession']>[0],
    'new'
  )
  return {
    agent: 'antigravity',
    label: 'Antigravity',
    rows: [{ agent: 'antigravity', kind: 'chat' }],
    surfaces: ['chat', 'terminal'],
    defaultSurface,
    terminal: {},
    structured: {},
    catalog: { origin: 'probe', fetchedAt: 1, models: options.read().models },
    coherentCatalog: true,
    catalogRead: 'settled',
    sourceCatalogs: {
      cli: {
        catalog: cliModelCatalogAnswer(cliResult)!,
        coherentCatalog: true,
        catalogRead: 'settled'
      }
    }
  }
}

import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'

// Why: these are the only GLM ids this repo can verify for ZCode. The v2 provider
// fixtures select `GLM-5.3`, and Z.AI's coding-plan guide names `GLM-5.3` and
// `GLM-5.3-Flash`. Older names from other harness docs are not seeded here.
const ZCODE_GLM_MODEL_IDS = ['GLM-5.3', 'GLM-5.3-Flash'] as const

const ZCODE_GLM_PROVIDERS = [
  {
    providerId: 'account:zai-individual-coding-plan',
    site: 'Z.AI'
  },
  {
    providerId: 'account:bigmodel-individual-coding-plan',
    site: 'BigModel'
  }
] as const

function zcodeModelLabel(modelId: (typeof ZCODE_GLM_MODEL_IDS)[number]): string {
  return modelId === 'GLM-5.3-Flash' ? 'GLM-5.3 Flash' : modelId
}

function zcodeCatalogModel(
  providerId: (typeof ZCODE_GLM_PROVIDERS)[number]['providerId'],
  site: string,
  modelId: (typeof ZCODE_GLM_MODEL_IDS)[number]
): CatalogModel {
  return {
    // Why: ZCode's `/model` reference is `providerId/modelId`. The provider id
    // has no slash, so this is the whole argument the slash command accepts.
    id: `${providerId}/${modelId}`,
    label: zcodeModelLabel(modelId),
    description: `${site} Coding Plan`,
    options: []
  }
}

export const ZCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: no `isDefault`. The account's provider file chooses the model, and a
  // seed flag would present a guess as the model this launch will run.
  models: ZCODE_GLM_PROVIDERS.flatMap((provider) =>
    ZCODE_GLM_MODEL_IDS.map((modelId) =>
      zcodeCatalogModel(provider.providerId, provider.site, modelId)
    )
  ),
  modelApply: {
    // Why: ZCode's interactive CLI has no `--model` flag. A launch arg would be
    // accepted by the picker and then dropped, which is worse than refusing it.
    // `/model` changes only the current session; `/settings` would rewrite the
    // shared provider file, which Orca leaves read-only.
    midSession: {
      kind: 'command',
      build: (value) => `/model ${String(value)}`,
      pickerCommand: '/model'
    }
  }
}

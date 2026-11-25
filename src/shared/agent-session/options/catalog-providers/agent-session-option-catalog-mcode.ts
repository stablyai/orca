import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

export const MCODE_MODEL_LABELS: Readonly<Record<string, string>> = {
  'MiniMax-M3.1-Flash': 'MiniMax M3.1 Flash',
  'MiniMax-M3': 'MiniMax M3',
  'MiniMax-M2.7-highspeed': 'MiniMax M2.7 Highspeed',
  'MiniMax-M2.7': 'MiniMax M2.7'
}

export type McodeModelRef = { providerId: string; modelId: string; variant?: string }

/** mcode's ACP selection id: percent-encoded parts, `v:<variant>` for a model with variants or `u` without. */
export function mcodeModelId({ providerId, modelId, variant }: McodeModelRef): string {
  return variant === undefined
    ? `m:${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}:u`
    : `m:${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}:v:${encodeURIComponent(variant)}`
}

/** The selection an ACP id names; null outside the `m:` scheme. */
export function parseMcodeModelId(id: string): McodeModelRef | null {
  if (!id.startsWith('m:')) {
    return null
  }
  const [provider, model, kind, variant, ...rest] = id.slice(2).split(':')
  if (!provider || !model || rest.length > 0) {
    return null
  }
  try {
    const ref = { providerId: decodeURIComponent(provider), modelId: decodeURIComponent(model) }
    if (kind === 'u' && variant === undefined) {
      return ref
    }
    return kind === 'v' && variant !== undefined
      ? { ...ref, variant: decodeURIComponent(variant) }
      : null
  } catch {
    return null
  }
}

/** Maps an ACP selection id to its `-m provider/model#variant` spelling; other ids pass through. */
export function mcodeCliModelFromId(id: string): string {
  const ref = parseMcodeModelId(id)
  return ref ? `${ref.providerId}/${ref.modelId}${ref.variant ? `#${ref.variant}` : ''}` : id
}

/** Labels that more than one provider's row of a model shares, so each can name its provider. */
export function mcodeSharedModelLabels(labels: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([label]) => label))
}

export const MCODE_EFFORT_CHOICES = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

// The `mcode` TUI reads effort from its config, so this choice reaches chats only.
export const MCODE_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: MCODE_EFFORT_CHOICES,
    defaultValue: 'default'
  },
  apply: {
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export const MCODE_ON_OFF_EFFORT_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' }
]

export const MCODE_ON_OFF_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: MCODE_ON_OFF_EFFORT_CHOICES,
    defaultValue: 'on'
  },
  apply: MCODE_EFFORT.apply
}

export const MCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  structuredSessionSeed: true,
  supportsWorkerLaunchPreferences: true,
  hostListingNamesConfiguredModel: true,
  models: [
    {
      id: 'm:minimax:MiniMax-M3.1-Flash:v:thinking',
      label: MCODE_MODEL_LABELS['MiniMax-M3.1-Flash'],
      contextWindowTokens: 512_000,
      isDefault: true,
      options: [MCODE_EFFORT]
    },
    {
      id: 'm:minimax:MiniMax-M3:v:thinking',
      label: MCODE_MODEL_LABELS['MiniMax-M3'],
      contextWindowTokens: 512_000,
      options: [MCODE_ON_OFF_EFFORT]
    }
  ],
  modelApply: {
    cli: [
      {
        kind: 'value',
        names: ['-m', '--model'],
        lift: 'separate-and-long-equals'
      }
    ],
    launchArgs: (value) => ['-m', mcodeCliModelFromId(String(value))],
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  unknownModelOptions: []
}

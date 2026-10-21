import type { AgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import type { TrackedNativeChatSessionOption } from './native-chat-session-option-state'

/** A model the list lacks has no effort menu, so the chat's own effort under it shows read-only:
 *  no list says which levels it takes, and a send carries the value unchanged. */
export function withUnlistedEffort(
  catalog: AgentSessionOptionCatalog,
  /** The model the picker draws the chat's controls under. */
  modelId: string | null,
  effort: TrackedNativeChatSessionOption | undefined,
  /** The ids the chat's own options answer lists; absent from an older host. */
  listed: readonly string[] | undefined,
  snapshot: SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  // A listed model with no effort menu takes none: only an unlisted one keeps its own.
  if (
    !modelId ||
    !listed ||
    listed.includes(modelId) ||
    typeof effort?.value !== 'string' ||
    snapshot.some((entry) => entry.id === 'effort')
  ) {
    return snapshot
  }
  // Named as a listed model's effort row names the same level.
  const listedEfforts = catalog.models
    .flatMap((model) => model.options)
    .filter((option) => option.id === 'effort')
  const level = listedEfforts
    .flatMap((option) => (option.kind.type === 'select' ? option.kind.choices : []))
    .find((choice) => choice.value === effort.value)
  const descriptor: SessionOptionDescriptor = {
    id: 'effort',
    label: listedEfforts[0]?.label ?? 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      currentValue: effort.value,
      choices: [level ?? { value: effort.value, label: effort.value }]
    },
    valueSource: effort.source,
    transport: 'agent-session',
    settable: false
  }
  return [...snapshot, descriptor]
}

import type { AgentType } from './agent-status-types'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { SessionOptionDescriptor } from './native-chat/input/native-chat-session-options'
import type { TrackedNativeChatSessionOption } from './native-chat/input/native-chat-session-option-state'

/** Unlisted models expose current effort read-only and send it unchanged; no listing proves which alternatives they accept. */
export function withUnlistedEffort(
  catalog: AgentSessionOptionCatalog,
  /** The model the picker draws the chat's controls under. */
  modelId: string | null,
  effort: TrackedNativeChatSessionOption | undefined,
  /** The ids the chat's own options answer lists; absent from an older host. */
  listed: readonly string[] | undefined,
  snapshot: SessionOptionDescriptor[],
  agent: AgentType
): SessionOptionDescriptor[] {
  if (!modelId || typeof effort?.value !== 'string') {
    return snapshot
  }
  if (
    agent !== 'pi' &&
    snapshot.some(
      (entry) =>
        entry.id === 'effort' &&
        entry.kind.type === 'select' &&
        entry.kind.choices.some((choice) => choice.value === effort.value)
    )
  ) {
    return snapshot
  }
  const offered = catalog.models
    .find((model) => model.id === modelId)
    ?.options.find((option) => option.id === 'effort')
  if (
    (listed?.includes(modelId) || (agent === 'pi' && !listed)) &&
    offered?.kind.type === 'select' &&
    offered.kind.choices.some((choice) => choice.value === effort.value)
  ) {
    return snapshot
  }
  // An old saved level remains visible without claiming it is offered now.
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
  return [...snapshot.filter((entry) => entry.id !== 'effort'), descriptor]
}

import type { TabEntryActionClassification, TabEntryOption } from './tab-create-entry-action'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import type { TabCreateMenuOption } from './tab-create-menu-options'

export type ActiveEntryOption = TabEntryOption & {
  classification: TabEntryActionClassification
}

// A row the user can act on in the new-tab open entry: a create-menu action, a
// matched agent to launch, or a file/URL entry.
export type ActiveOption =
  | {
      kind: 'agent'
      option: TabAgentLaunchOption
    }
  | {
      kind: 'entry'
      option: ActiveEntryOption
    }
  | {
      kind: 'menu'
      option: TabCreateMenuOption
    }

export function isActiveEntryOption(option: TabEntryOption): option is ActiveEntryOption {
  return option.classification.kind !== 'empty' && option.classification.kind !== 'blocked'
}

export function getActiveOptionId(option: ActiveOption): string {
  if (option.kind === 'agent') {
    return `agent:${option.option.agent}`
  }
  if (option.kind === 'menu') {
    return `menu:${option.option.id}`
  }
  return option.option.id
}

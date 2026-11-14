import { disambiguateSubagentLabels } from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-items'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { nativeChatSubagentChain } from './native-chat-subagent-scope'

export type NativeChatSubagentSwitcherItem = { id: string; label: string; depth: number }

/** Every subagent, each spawner's children right under it; repeated or missing names get ordinals. */
export function nativeChatSubagentSwitcherItems(
  entries: ReadonlyMap<string, NativeChatSubagentEntry>,
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>,
  unnamed: string
): readonly NativeChatSubagentSwitcherItem[] {
  const ids = [
    ...entries.keys(),
    ...Array.from(subagentRows.keys()).filter((id) => !entries.has(id))
  ]
  const labels = new Map(
    disambiguateSubagentLabels(ids.map((id) => entries.get(id)?.label ?? unnamed)).map(
      (label, index) => [ids[index]!, label]
    )
  )
  const parentOf = new Map(
    ids.map((id) => [id, nativeChatSubagentChain(id, subagentRows).at(-2) ?? null])
  )
  const items: NativeChatSubagentSwitcherItem[] = []
  const placed = new Set<string>()
  const place = (parent: string | null, depth: number): void => {
    for (const id of ids) {
      if (!placed.has(id) && parentOf.get(id) === parent) {
        placed.add(id)
        items.push({ id, label: labels.get(id)!, depth })
        place(id, depth + 1)
      }
    }
  }
  place(null, 0)
  // A spawner no entry names leaves its children unplaced; they list at the top level.
  for (const id of ids) {
    if (!placed.has(id)) {
      placed.add(id)
      items.push({ id, label: labels.get(id)!, depth: 0 })
      place(id, 1)
    }
  }
  return items
}

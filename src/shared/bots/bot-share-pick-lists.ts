// Which items of a part a share carries, as the owner's ticks read: free of the package schema, so
// the phone's page bundle takes it too.
import { BOT_SHARE_MAX_PICKS } from '../rpc-contract/bots-share-params'

/** The picked names of a part: an absent list is all of them. */
export function pickedOf(names: readonly string[] | undefined, all: readonly string[]): string[] {
  return names ? all.filter((name) => names.includes(name)) : [...all]
}

export function toggled(picked: readonly string[], name: string, on: boolean): string[] {
  return on ? [...picked, name] : picked.filter((entry) => entry !== name)
}

/** Every memory file a share can carry: all of them, or the first BOT_SHARE_MAX_PICKS when there are more. */
export function allMemory(notes: readonly { topic: string }[]): string[] {
  return notes.slice(0, BOT_SHARE_MAX_PICKS).map((note) => note.topic)
}

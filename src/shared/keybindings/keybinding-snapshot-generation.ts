import type { KeybindingFileSnapshot } from './types'

/** A late reply (get, save, open) must not undo a newer broadcast's predicate and map. */
export function isOlderKeybindingSnapshot(
  current: Pick<KeybindingFileSnapshot, 'generation'> | null,
  incoming: Pick<KeybindingFileSnapshot, 'generation'>
): boolean {
  return (
    typeof current?.generation === 'number' &&
    typeof incoming.generation === 'number' &&
    incoming.generation < current.generation
  )
}

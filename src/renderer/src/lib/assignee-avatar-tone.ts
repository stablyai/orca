/** Identity of a person a work item can be assigned to. */
export type AssigneeIdentity = {
  id?: string | null
  displayName?: string | null
}

/** Whole class strings, never assembled: the design-system lint rejects a
 *  computed class name, and Tailwind cannot generate one it never sees. */
const AVATAR_TONE_CLASSES = [
  'bg-avatar-tone-1 text-avatar-tone-1-foreground',
  'bg-avatar-tone-2 text-avatar-tone-2-foreground',
  'bg-avatar-tone-3 text-avatar-tone-3-foreground',
  'bg-avatar-tone-4 text-avatar-tone-4-foreground',
  'bg-avatar-tone-5 text-avatar-tone-5-foreground',
  'bg-avatar-tone-6 text-avatar-tone-6-foreground',
  'bg-avatar-tone-7 text-avatar-tone-7-foreground',
  'bg-avatar-tone-8 text-avatar-tone-8-foreground'
] as const

/** Nobody to identify, so no identity colour. */
export const NEUTRAL_AVATAR_TONE = 'bg-muted/40 text-muted-foreground'

/** FNV-1a. Cheap, dependency-free, and spreads short keys well enough that
 *  neighbouring ids do not land on the same tone. */
function hashIdentityKey(key: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Picks the tone for an assignee, stable for the life of their id.
 *  Keyed on the id, not the name: a profile rename must not recolour someone. */
export function getAssigneeAvatarTone(assignee: AssigneeIdentity | null | undefined): string {
  const key = assignee?.id?.trim() || assignee?.displayName?.trim() || ''
  if (key === '') {
    return NEUTRAL_AVATAR_TONE
  }
  return AVATAR_TONE_CLASSES[hashIdentityKey(key) % AVATAR_TONE_CLASSES.length]
}

/** Exposed so a test can assert spread across the whole palette. */
export const AVATAR_TONE_COUNT = AVATAR_TONE_CLASSES.length

import type { ShortcutStory } from './shortcut-types'

// Shortcut's canonical story reference (matches its sc-<id> branch convention).
export function shortcutStoryReference(story: Pick<ShortcutStory, 'id'>): string {
  return `sc-${story.id}`
}

/** Escape regex metacharacters for use in a RegExp constructor. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

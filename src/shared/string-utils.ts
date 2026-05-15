/**
 * Escape special regex characters in a string for use in RegExp constructor.
 *
 * Why: When building a regex from user input or file paths, special regex
 * characters (. * + ? ^ $ { } ( ) | [ ] \) must be escaped to match literally.
 *
 * @param str - String to escape
 * @returns Escaped string safe for use in new RegExp()
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

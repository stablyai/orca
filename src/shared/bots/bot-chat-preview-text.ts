/** A chat's last message as its row's one muted line: links keep their label, code ticks, emphasis,
 *  heading and list marks drop, and table rows go, so the line reads as plain words. */
export function botChatPreviewText(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ''))
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

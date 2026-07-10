// Prepare a raw .wiki/ note for in-panel display: hide frontmatter tags and make wikilinks clickable.

/** Strips a leading YAML frontmatter block from note content, if present. */
export function stripFrontmatter(content: string): string {
  // Remove a leading YAML frontmatter block so page tags don't render as body text.
  const match = content.match(/^﻿?---[^\n]*\n[\s\S]*?\n---[ \t]*(?:\r?\n|$)/)
  return match ? content.slice(match[0].length) : content
}

/** Converts `[[target]]` / `[[target|label]]` / `[[target#anchor]]` wikilinks into standard markdown links. */
export function wikilinksToMarkdownLinks(content: string): string {
  // [[target]] / [[target|label]] / [[target#anchor]] -> [label](target) so the renderer makes them clickable.
  return content.replace(
    /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g,
    (_full, target, label) => {
      const cleanTarget = String(target).trim()
      const text = (label ?? cleanTarget).toString().trim()
      // Why: a bare space in the link destination breaks CommonMark parsing.
      const dest = /\s/.test(cleanTarget) ? `<${cleanTarget}>` : cleanTarget
      return `[${text}](${dest})`
    }
  )
}

/** Prepares raw `.wiki/` note content for in-panel display: strips frontmatter and rewrites wikilinks as markdown links. */
export function prepareWikiNoteForDisplay(content: string): string {
  return wikilinksToMarkdownLinks(stripFrontmatter(content))
}

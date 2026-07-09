// Prepare a raw .wiki/ note for in-panel display: hide frontmatter tags and make wikilinks clickable.

export function stripFrontmatter(content: string): string {
  // Remove a leading YAML frontmatter block so page tags don't render as body text.
  const match = content.match(/^﻿?---[^\n]*\n[\s\S]*?\n---[ \t]*(?:\r?\n|$)/)
  return match ? content.slice(match[0].length) : content
}

export function wikilinksToMarkdownLinks(content: string): string {
  // [[target]] / [[target|label]] / [[target#anchor]] -> [label](target) so the renderer makes them clickable.
  return content.replace(
    /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g,
    (_full, target, label) => {
      const cleanTarget = String(target).trim()
      const text = (label ?? cleanTarget).toString().trim()
      return `[${text}](${cleanTarget})`
    }
  )
}

export function prepareWikiNoteForDisplay(content: string): string {
  return wikilinksToMarkdownLinks(stripFrontmatter(content))
}

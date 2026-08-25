export function getCardOpeningTag(markup: string, worktreeId: string): string {
  return (
    markup.match(
      new RegExp(`<section[^>]*data-worktree-card-id="${escapeRegExp(worktreeId)}"[^>]*>`)
    )?.[0] ?? ''
  )
}

export function getOptionOpeningTag(markup: string, worktreeId: string): string {
  // Why: option ids are keyed by the row's rowKey, which is
  // `<section>:<host>|<worktreeId>` once URI-encoded (e.g. all%3Alocal%7Cchild).
  // The worktree id is the suffix after the encoded host separator (STA-4343).
  return (
    markup.match(
      new RegExp(`<div[^>]*id="worktree-list-option-[^"]*%7C${escapeRegExp(worktreeId)}"[^>]*>`)
    )?.[0] ?? ''
  )
}

export function getFolderWorkspaceSurfaceOpeningTag(
  markup: string,
  folderWorkspaceId: string
): string {
  return (
    markup.match(
      new RegExp(
        `<div[^>]*id="worktree-list-option-[^"]*%3A${escapeRegExp(folderWorkspaceId)}"[^>]*>` +
          `[\\s\\S]*?<div class="relative"[^>]*>`
      )
    )?.[0] ?? ''
  )
}

export function getDataNumber(openingTag: string, attribute: string): number {
  return Number(openingTag.match(new RegExp(`${attribute}="(\\d+)"`))?.[1] ?? 0)
}

export function getPaddingLeft(openingTag: string): number {
  return Number(openingTag.match(/padding-left:(\d+)px/)?.[1] ?? 0)
}

export function getFlushCardContentStart(args: {
  cardContentIndent: number
  surfaceInset: number
}): number {
  const flushCardMargin = 4
  const flushCardMinimumInset = 2
  const flushCardPullback = 4

  return (
    args.surfaceInset +
    flushCardMargin +
    Math.max(flushCardMinimumInset, args.cardContentIndent - flushCardPullback)
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

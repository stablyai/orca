export type TabReferenceKind = 'terminal' | 'chat' | 'editor' | 'browser'

export type TabReference = {
  unifiedTabId: string
  kind: TabReferenceKind
  /** The page the `orca tab` commands take as `--page`; the workspace tab id is not accepted there. */
  browserPageId?: string | null
  filePath?: string | null
}

// Why the extra lines: the workspace tab id alone does not say what the tab is, and no CLI command
// resolves it for browser tabs, so an agent given only the id has to guess the tab by title or URL.
// The first line stays `orcaTabId: <id>` so references copied before this change still read the same.
export function formatTabReference(reference: TabReference): string {
  const lines = [`orcaTabId: ${reference.unifiedTabId}`, `tabKind: ${reference.kind}`]
  if (reference.kind === 'browser' && reference.browserPageId) {
    lines.push(`browserPageId: ${reference.browserPageId}`)
  }
  if (reference.kind === 'editor' && reference.filePath) {
    lines.push(`filePath: ${reference.filePath}`)
  }
  return lines.join('\n')
}

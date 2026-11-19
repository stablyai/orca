export const FILE_EXPLORER_DROP_DIR_ATTRIBUTE = 'data-file-explorer-drop-dir'

export function readFileExplorerDropDir(
  root: HTMLElement | null,
  target: EventTarget | null
): string | null {
  const row =
    target instanceof Element ? target.closest(`[${FILE_EXPLORER_DROP_DIR_ATTRIBUTE}]`) : null
  return row && root?.contains(row) ? row.getAttribute(FILE_EXPLORER_DROP_DIR_ATTRIBUTE) : null
}

export function readFileExplorerPasteDir(
  root: HTMLElement | null,
  target: EventTarget | null
): string | null {
  const row =
    target instanceof Element ? target.closest(`[${FILE_EXPLORER_DROP_DIR_ATTRIBUTE}]`) : null
  return row && root?.contains(row) && row.hasAttribute('data-file-explorer-drop-directory')
    ? row.getAttribute(FILE_EXPLORER_DROP_DIR_ATTRIBUTE)
    : null
}

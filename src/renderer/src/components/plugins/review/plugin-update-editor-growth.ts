// How an update's custom editors reach further than the installed ones, for the update review.

type EditorReach = {
  id?: string
  extensions?: readonly string[]
  filenames?: readonly string[]
  priority?: string
  contentKind?: string
}
export type EditorManifest = { contributes: { customEditors?: readonly EditorReach[] } }

/**
 * How the update's editors reach further than the installed ones, per editor id as main compares
 * them: file types no installed editor opened, file types an editor now opens by default, and
 * whether anything else grew (a new id over held files, a changed content kind).
 */
export function editorGrowth(
  installed: EditorManifest | null | undefined,
  next: EditorManifest
): { files: string[]; defaults: string[]; other: boolean } {
  const filesOf = (editor: EditorReach): string[] => [
    ...(editor.extensions ?? []),
    ...(editor.filenames ?? [])
  ]
  const held = installed?.contributes.customEditors ?? []
  const heldFiles = new Set(held.flatMap(filesOf).map((file) => file.toLowerCase()))
  const files: string[] = []
  const defaults: string[] = []
  let other = false
  for (const editor of next.contributes.customEditors ?? []) {
    const before = held.find((candidate) => candidate.id === editor.id)
    const beforeFiles = new Set((before ? filesOf(before) : []).map((file) => file.toLowerCase()))
    const added = filesOf(editor).filter((file) => !beforeFiles.has(file.toLowerCase()))
    const unheld = added.filter((file) => !heldFiles.has(file.toLowerCase()))
    files.push(...unheld)
    if (added.length > unheld.length) {
      other = true
    }
    if (before) {
      if (editor.priority !== 'option' && before.priority === 'option') {
        defaults.push(...filesOf(editor).filter((file) => beforeFiles.has(file.toLowerCase())))
      }
      if ((editor.contentKind ?? 'text') !== (before.contentKind ?? 'text')) {
        other = true
      }
    }
  }
  const unique = (list: string[]): string[] => {
    const seen = new Set<string>()
    return list.filter((file) => !seen.has(file.toLowerCase()) && seen.add(file.toLowerCase()))
  }
  return { files: unique(files), defaults: unique(defaults), other }
}

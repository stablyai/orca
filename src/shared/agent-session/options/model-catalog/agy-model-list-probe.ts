export const AGY_MODEL_LIST_ARGS = ['models']

/** Read agy's TSV without turning diagnostic lines or duplicate IDs into picker rows. */
export function parseAgyModelRows(stdout: string): { id: string; label: string }[] {
  const rows = new Map<string, { id: string; label: string }>()
  for (const line of stdout.split(/\r?\n/)) {
    const [id, label, ...extra] = line.split('\t').map((field) => field.trim())
    if (id && !/\s/.test(id) && label && extra.length === 0 && !rows.has(id)) {
      rows.set(id, { id, label })
    }
  }
  return [...rows.values()]
}

const DIALOG_HINT = /esc to (?:cancel|go back|exit)|press enter to|enter to (?:confirm|select)/i
const COMPOSER_ROW = /^\s*(?:[│┃]\s*)?[❯›»>]\s*(?:$|[^\d])/u

/** Only the current input region owns keys; old hints above its composer are history. */
export function findAgentInputDialogIndex(text: string): number | null {
  const rows = text.split('\n')
  let composer = -1
  for (let i = 0; i < rows.length; i += 1) {
    if (COMPOSER_ROW.test(rows[i]) && !/yes|no,? exit|allow|deny|accept/i.test(rows[i])) {
      composer = i
    }
  }
  const indices = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row, i }) => i > composer && row.trim())
  for (const { row, i } of indices.slice(-6)) {
    // A live spinner and empty composer leave cancellation in the turn footer.
    if (
      composer >= 0 &&
      /esc to cancel/i.test(row) &&
      !/press enter|enter to|select|confirm/i.test(row) &&
      /^\s*(?:[│┃]\s*)?[❯›»>]\s*$/u.test(rows[composer]) &&
      rows.slice(0, composer).some((line) => /^\s*[\u2801-\u28ff]/u.test(line))
    ) {
      continue
    }
    if (
      !DIALOG_HINT.test(row) &&
      !/enter\s*(?:confirm|continue)\s*·|enter\/esc\s*(?:continue|confirm)|do you trust|trust this (?:folder|workspace|directory|repo)/i.test(
        row
      )
    ) {
      continue
    }
    return rows.slice(0, i).reduce((length, previous) => length + previous.length + 1, 0)
  }
  return null
}

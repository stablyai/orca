const LEADING_DATE = /^(\d{4})-(\d{2})-(\d{2})/

/** Date.parse rolls a day the month doesn't have into the next one (Feb 30 becomes Mar 2), so a
 *  leading YYYY-MM-DD is read back to refuse it. Date.UTC maps years 0-99 to 19xx, so those are
 *  refused too. Text that doesn't start with a YYYY-MM-DD passes. */
export function hasImpossibleLeadingDate(text: string): boolean {
  const match = LEADING_DATE.exec(text)
  if (!match) {
    return false
  }
  const [year, month, day] = match.slice(1).map(Number)
  const read = new Date(Date.UTC(year, month - 1, day))
  return (
    read.getUTCFullYear() !== year || read.getUTCMonth() !== month - 1 || read.getUTCDate() !== day
  )
}

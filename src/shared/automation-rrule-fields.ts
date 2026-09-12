export function parseRruleEntries(rrule: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const part of rrule.split(';')) {
    const terms = part.split('=')
    const [key, value] = terms
    if (terms.length !== 2 || !key || !value || entries.has(key.toUpperCase())) {
      throw new Error('Invalid recurrence field.')
    }
    const normalizedKey = key.toUpperCase()
    if (!['FREQ', 'BYHOUR', 'BYMINUTE', 'BYDAY'].includes(normalizedKey)) {
      throw new Error(`Unsupported recurrence field: ${key}.`)
    }
    entries.set(normalizedKey, value)
  }
  return entries
}

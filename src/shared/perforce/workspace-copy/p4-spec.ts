// Spec forms as `p4 client -o` / `p4 stream -o` print them and `-i` reads them back.

const MULTI_LINE_FIELDS = new Set([
  'Description',
  'View',
  'AltRoots',
  'ChangeView',
  'LimitView',
  'Paths',
  'Remapped',
  'Ignored',
  'Components',
  'Files',
  'Jobs'
])

/** Field name -> its lines, in the order the form printed them. */
export type P4Spec = Map<string, string[]>

export function parseP4Spec(text: string): P4Spec {
  const spec: P4Spec = new Map()
  let key: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      continue
    }
    const field = /^([A-Za-z]+):[ \t]?(.*)$/.exec(line)
    if (field) {
      key = field[1]
      const value = field[2].trim()
      spec.set(key, value === '' ? [] : [value])
      continue
    }
    const continuation = /^[ \t]+(.*)$/.exec(line)
    if (key !== null && continuation) {
      spec.get(key)?.push(continuation[1])
    }
  }
  return spec
}

export function formatP4Spec(spec: P4Spec): string {
  const out: string[] = []
  for (const [key, rawValues] of spec) {
    const values = [...rawValues]
    while (values.length > 0 && values.at(-1)?.trim() === '') {
      values.pop()
    }
    if (MULTI_LINE_FIELDS.has(key)) {
      out.push(`${key}:`, ...values.map((value) => `\t${value}`))
    } else {
      out.push(`${key}:\t${values.join(' ')}`)
    }
    out.push('')
  }
  return `${out.join('\n')}\n`
}

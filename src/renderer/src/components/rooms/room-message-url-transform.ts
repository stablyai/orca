import { defaultUrlTransform } from 'react-markdown'

/** Room messages can embed local screenshots; remote images stay blocked so agent
 *  output cannot pull in tracking pixels or unreviewed network content. */
export function roomMessageUrlTransform(value: string, key: string): string {
  if (key === 'src') {
    const protocol = value.slice(0, value.indexOf(':') + 1).toLowerCase()
    if (protocol === 'data:') {
      return value
    }
    if (protocol === 'file:') {
      try {
        const { hostname } = new URL(value)
        return hostname === '' || hostname === 'localhost' ? value : ''
      } catch {
        return ''
      }
    }
    return ''
  }
  return defaultUrlTransform(value)
}

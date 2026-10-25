import { createBrowserUuid } from '@/lib/browser-uuid'

export function readNativeChatAnnotationRecord<T>(
  key: string,
  quarantinePrefix: string,
  validate: (value: unknown) => value is T,
  onQuarantined?: () => void
): T | undefined {
  const stored = localStorage.getItem(key)
  if (stored === null) {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(stored)
  } catch {
    value = undefined
  }
  if (validate(value)) {
    return value
  }
  // Preserve unreadable data before removing an unchanged active record.
  localStorage.setItem(
    `${quarantinePrefix}${encodeURIComponent(key)}:${createBrowserUuid()}`,
    stored
  )
  if (localStorage.getItem(key) === stored) {
    localStorage.removeItem(key)
  }
  onQuarantined?.()
  return undefined
}

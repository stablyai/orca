import { win32 } from 'node:path'

const WINDOWS_DEVICE_PATH_PREFIX = /^\\\\[?.]\\/
const WINDOWS_DRIVE_PATH_PREFIX = /^[A-Za-z]:[\\/]/
const WINDOWS_EXTENDED_UNC_PREFIX = /^\\\\\?\\UNC[\\/]/i
const WINDOWS_EXTENDED_UNC_PATH = /^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+(?:[\\/]|$)/i
const INVALID_WINDOWS_COMPONENT_CHARACTERS = '<>"|?*;:'

export function normalizeSingleWindowsPathEntry(value: string | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized || !hasFullyQualifiedWindowsRoot(normalized)) {
    return null
  }

  const isDevicePath = WINDOWS_DEVICE_PATH_PREFIX.test(normalized)
  const withoutDevicePrefix = isDevicePath ? normalized.slice(4) : normalized
  const withoutDrive = WINDOWS_DRIVE_PATH_PREFIX.test(withoutDevicePrefix)
    ? withoutDevicePrefix.slice(2)
    : withoutDevicePrefix

  if (hasInvalidWindowsPathEntryCharacter(withoutDrive)) {
    return null
  }
  if (!isDevicePath && hasInvalidOrdinaryWindowsComponent(withoutDrive)) {
    return null
  }
  return normalized
}

function hasFullyQualifiedWindowsRoot(value: string): boolean {
  if (!win32.isAbsolute(value) || win32.parse(value).root.length <= 1) {
    return false
  }
  return !WINDOWS_EXTENDED_UNC_PREFIX.test(value) || WINDOWS_EXTENDED_UNC_PATH.test(value)
}

function hasInvalidWindowsPathEntryCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 32 || INVALID_WINDOWS_COMPONENT_CHARACTERS.includes(character)) {
      return true
    }
  }
  return false
}

function hasInvalidOrdinaryWindowsComponent(value: string): boolean {
  return value
    .split(/[\\/]/)
    .filter(Boolean)
    .some(
      (component) =>
        component !== '.' &&
        component !== '..' &&
        (component.endsWith(' ') || component.endsWith('.'))
    )
}

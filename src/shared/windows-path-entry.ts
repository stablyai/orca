const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/](.*)$/s
const WINDOWS_UNC_PATH = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/s
const WINDOWS_VOLUME_PATH =
  /^\\\\\.\\(Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})\\(.*)$/is
const WINDOWS_DEVICE_PATH_PREFIX = /^\\\\[?.]\\/
const WINDOWS_EXTENDED_PATH_PREFIX = /^\\\\\?\\/
const INVALID_WINDOWS_COMPONENT_CHARACTERS = '<>"|?*;:'
const RESERVED_WINDOWS_COMPONENT =
  /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i

type ParsedWindowsPath = {
  components: string[]
  uncShare?: string
}

export function normalizeSingleWindowsPathEntry(value: string | undefined): string | null {
  if (!value || value.trim() !== value) {
    return null
  }

  const parsed = parseWindowsFilesystemPath(value)
  if (!parsed || parsed.uncShare?.toLowerCase() === 'pipe') {
    return null
  }
  return parsed.components.some(hasInvalidWindowsComponent) ? null : value
}

function parseWindowsFilesystemPath(value: string): ParsedWindowsPath | null {
  // Why: cmd rejects extended PATH entries, and extended volumes can poison later child lookup.
  if (WINDOWS_EXTENDED_PATH_PREFIX.test(value)) {
    return null
  }
  if (WINDOWS_DEVICE_PATH_PREFIX.test(value) && value.includes('/')) {
    return null
  }

  let match = WINDOWS_VOLUME_PATH.exec(value)
  if (match) {
    return { components: [match[1], ...splitWindowsComponents(match[2])] }
  }

  if (WINDOWS_DEVICE_PATH_PREFIX.test(value)) {
    return null
  }

  match = WINDOWS_DRIVE_PATH.exec(value)
  if (match) {
    return { components: splitWindowsComponents(match[1]) }
  }

  match = WINDOWS_UNC_PATH.exec(value)
  if (match) {
    return {
      components: [match[1], match[2], ...splitWindowsComponents(match[3])],
      uncShare: match[2]
    }
  }

  return null
}

function splitWindowsComponents(value: string | undefined): string[] {
  return value?.split(/[\\/]/).filter(Boolean) ?? []
}

function hasInvalidWindowsComponent(component: string): boolean {
  if (component === '.' || component === '..') {
    return false
  }
  if (component.endsWith(' ') || component.endsWith('.')) {
    return true
  }
  for (const character of component) {
    if (character.charCodeAt(0) < 32 || INVALID_WINDOWS_COMPONENT_CHARACTERS.includes(character)) {
      return true
    }
  }
  return RESERVED_WINDOWS_COMPONENT.test(component.split('.')[0].trimEnd())
}

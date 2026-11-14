import type { RgOutputMode } from './quick-open-filter'

export function getQuickOpenRgOutputMode(
  rawLine: string,
  translatedLine: string,
  rootPath: string
): RgOutputMode {
  return translatedLine !== rawLine ||
    rawLine.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(rawLine) ||
    rawLine.startsWith('\\\\')
    ? { kind: 'absolute', rootPath }
    : { kind: 'cwd-relative' }
}

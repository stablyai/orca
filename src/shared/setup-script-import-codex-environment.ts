import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import {
  isSetupScriptImportFieldWithinLimit,
  SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES,
  SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS,
  SETUP_SCRIPT_IMPORT_MAX_TOML_LINES,
  SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS
} from './setup-script-import-limits'
import { measureUtf8ByteLength } from './utf8-byte-limits'

const CODEX_ENVIRONMENT_PATH = '.codex/environments/environment.toml'

type CodexEnvironmentToml = {
  setupScript?: string
  cleanupScript?: string
  unsupportedFields: string[]
}

export async function inspectCodexEnvironmentConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const content = await readFile(CODEX_ENVIRONMENT_PATH)
  if (!content) {
    return null
  }

  const parsed = parseCodexEnvironmentToml(content)
  const setup = normalizeCodexScript(parsed.setupScript)
  if (!setup) {
    return null
  }

  return {
    provider: 'codex',
    label: 'Codex environment',
    files: [CODEX_ENVIRONMENT_PATH],
    setup,
    archive: normalizeCodexScript(parsed.cleanupScript) || undefined,
    unsupportedFields: parsed.unsupportedFields
  }
}

function parseCodexEnvironmentToml(content: string): CodexEnvironmentToml {
  if (countTomlLines(content) > SETUP_SCRIPT_IMPORT_MAX_TOML_LINES) {
    return { unsupportedFields: [] }
  }
  const lines = content.split(/\r?\n/)
  const unsupportedFields: string[] = []
  let section = ''
  let setupScript: string | undefined
  let cleanupScript: string | undefined

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()
    if (/^actions\s*=/.test(trimmed)) {
      pushUnsupportedField(unsupportedFields, 'actions')
    }
    const sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/)
    if (sectionMatch) {
      section = sectionMatch[1]
      if (section === 'actions' || section.startsWith('actions.')) {
        pushUnsupportedField(unsupportedFields, `[${section}]`)
      }
      continue
    }

    if (section !== 'setup' && section !== 'cleanup') {
      continue
    }

    const assignment = line.match(/^\s*script\s*=\s*(.*)$/)
    if (!assignment) {
      continue
    }

    const parsed = parseTomlStringValue(lines, index, assignment[1])
    index = parsed.endLineIndex
    if (section === 'setup') {
      setupScript = parsed.value
    } else {
      cleanupScript = parsed.value
    }
  }

  return { setupScript, cleanupScript, unsupportedFields }
}

function parseTomlStringValue(
  lines: string[],
  startLineIndex: number,
  rawValue: string
): { value: string; endLineIndex: number } {
  const value = rawValue.trimStart()
  if (value.startsWith('"""') || value.startsWith("'''")) {
    const delimiter = value.startsWith('"""') ? '"""' : "'''"
    return parseTomlMultilineString(lines, startLineIndex, value.slice(3), delimiter)
  }
  if (value.startsWith('"')) {
    return { value: parseTomlBasicString(value), endLineIndex: startLineIndex }
  }
  if (value.startsWith("'")) {
    return { value: parseTomlLiteralString(value), endLineIndex: startLineIndex }
  }
  return { value: value.replace(/\s+#.*$/, '').trim(), endLineIndex: startLineIndex }
}

function parseTomlMultilineString(
  lines: string[],
  startLineIndex: number,
  firstLineRemainder: string,
  delimiter: '"""' | "'''"
): { value: string; endLineIndex: number } {
  const chunks: string[] = []
  let retainedBytes = 0
  let retainedCodeUnits = 0
  let remainder = firstLineRemainder
  let oversized = false
  const append = (value: string): boolean => {
    if (retainedCodeUnits + value.length > SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS) {
      return false
    }
    const measurement = measureUtf8ByteLength(value, {
      stopAfterBytes: SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES - retainedBytes
    })
    if (measurement.exceededLimit) {
      return false
    }
    chunks.push(value)
    retainedBytes += measurement.byteLength
    retainedCodeUnits += value.length
    return true
  }
  for (let index = startLineIndex; index < lines.length; index++) {
    if (index > startLineIndex) {
      remainder = lines[index]
    }
    const closeIndex = remainder.indexOf(delimiter)
    if (closeIndex >= 0) {
      if (!oversized && !append(remainder.slice(0, closeIndex))) {
        oversized = true
      }
      return {
        value: oversized ? '' : chunks.join(''),
        endLineIndex: index
      }
    }
    if (!oversized && !append(`${remainder}\n`)) {
      oversized = true
      chunks.length = 0
    }
  }
  return {
    value: oversized ? '' : chunks.join('').trimEnd(),
    endLineIndex: lines.length - 1
  }
}

function parseTomlBasicString(value: string): string {
  const raw = value.slice(0, findTomlStringEnd(value, '"') + 1)
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

function parseTomlLiteralString(value: string): string {
  const end = findTomlStringEnd(value, "'")
  return value.slice(1, end)
}

function findTomlStringEnd(value: string, quote: '"' | "'"): number {
  for (let index = 1; index < value.length; index++) {
    if (value[index] !== quote) {
      continue
    }
    if (quote === "'" || !isEscaped(value, index)) {
      return index
    }
  }
  return value.length - 1
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
    slashCount++
  }
  return slashCount % 2 === 1
}

function normalizeCodexScript(value: string | undefined): string {
  if (!value || !isSetupScriptImportFieldWithinLimit(value)) {
    return ''
  }
  return value.trim()
}

function countTomlLines(content: string): number {
  let lines = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10 && ++lines > SETUP_SCRIPT_IMPORT_MAX_TOML_LINES) {
      return lines
    }
  }
  return lines
}

function pushUnsupportedField(fields: string[], value: string): void {
  if (fields.length < SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS) {
    fields.push(value)
  }
}

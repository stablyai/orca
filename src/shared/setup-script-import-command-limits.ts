import {
  isSetupScriptImportFieldWithinLimit,
  SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS,
  SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS,
  SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS
} from './setup-script-import-limits'

export function normalizeSetupScriptImportCommand(value: unknown): string {
  if (typeof value === 'string') {
    return normalizeCommandString(value)
  }
  if (!Array.isArray(value) || value.length > SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS) {
    return ''
  }
  const commands: string[] = []
  for (const item of value) {
    const command = typeof item === 'string' ? normalizeCommandString(item) : ''
    if (command) {
      commands.push(command)
    }
  }
  return joinSetupScriptImportCommands(commands)
}

export function joinSetupScriptImportCommands(parts: string[]): string {
  let command = ''
  for (const part of parts) {
    const next = command ? `${command}\n${part}` : part
    if (!isSetupScriptImportFieldWithinLimit(next)) {
      return ''
    }
    command = next
  }
  return command
}

export function pushSetupScriptImportUnsupportedField(fields: string[], value: string): void {
  if (fields.length < SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS) {
    fields.push(value)
  }
}

function normalizeCommandString(value: string): string {
  if (value.length > SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS) {
    return ''
  }
  const trimmed = value.trim()
  return trimmed && isSetupScriptImportFieldWithinLimit(trimmed) ? trimmed : ''
}

import { measureUtf8ByteLength } from './utf8-byte-limits'

export const SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES = 256 * 1024
export const SETUP_SCRIPT_IMPORT_MAX_CODE_UNITS = 256 * 1024
export const SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES = 64 * 1024
export const SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS = 64 * 1024
export const SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS = 256
export const SETUP_SCRIPT_IMPORT_MAX_CMUX_COMMANDS = 256
export const SETUP_SCRIPT_IMPORT_MAX_KEYWORDS = 64
export const SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS = 128
export const SETUP_SCRIPT_IMPORT_MAX_TOML_LINES = 4_096

export function isSetupScriptImportTextWithinLimit(content: string): boolean {
  return isTextWithinLimits(
    content,
    SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES,
    SETUP_SCRIPT_IMPORT_MAX_CODE_UNITS
  )
}

export function isSetupScriptImportFieldWithinLimit(value: string): boolean {
  return isTextWithinLimits(
    value,
    SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES,
    SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS
  )
}

function isTextWithinLimits(value: string, maxBytes: number, maxCodeUnits: number): boolean {
  return (
    value.length <= maxCodeUnits &&
    !measureUtf8ByteLength(value, { stopAfterBytes: maxBytes }).exceededLimit
  )
}

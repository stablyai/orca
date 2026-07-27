import { measureUtf8ByteLength } from './utf8-byte-limits'

export const MAX_ORCA_YAML_BYTES = 256 * 1024
export const MAX_ORCA_YAML_CODE_UNITS = 256 * 1024
export const MAX_ORCA_YAML_FIELD_BYTES = 64 * 1024
export const MAX_ORCA_YAML_FIELD_CODE_UNITS = 64 * 1024
export const MAX_ORCA_YAML_COLLECTION_ENTRIES = 256
export const MAX_ORCA_YAML_ALIAS_COUNT = 20

export function isOrcaYamlTextWithinLimit(content: string): boolean {
  return (
    content.length <= MAX_ORCA_YAML_CODE_UNITS &&
    !measureUtf8ByteLength(content, { stopAfterBytes: MAX_ORCA_YAML_BYTES }).exceededLimit
  )
}

export function isOrcaYamlFieldWithinLimit(value: string): boolean {
  return (
    value.length <= MAX_ORCA_YAML_FIELD_CODE_UNITS &&
    !measureUtf8ByteLength(value, { stopAfterBytes: MAX_ORCA_YAML_FIELD_BYTES }).exceededLimit
  )
}

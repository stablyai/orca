import { measureUtf8ByteLength } from './utf8-byte-limits'

export const MCP_CONFIG_INSPECTION_MAX_BYTES = 256 * 1024
export const MCP_CONFIG_INSPECTION_MAX_CODE_UNITS = 256 * 1024
export const MCP_CONFIG_INSPECTION_MAX_SERVERS = 256
export const MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS = 256
export const MCP_CONFIG_INSPECTION_MAX_NAME_BYTES = 4 * 1024
export const MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS = 4 * 1024
export const MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES = 64 * 1024
export const MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS = 64 * 1024

export function isMcpConfigInspectionTextWithinLimit(content: string): boolean {
  return isTextWithinLimits(
    content,
    MCP_CONFIG_INSPECTION_MAX_BYTES,
    MCP_CONFIG_INSPECTION_MAX_CODE_UNITS
  )
}

export function isMcpConfigInspectionNameWithinLimit(value: string): boolean {
  return isTextWithinLimits(
    value,
    MCP_CONFIG_INSPECTION_MAX_NAME_BYTES,
    MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS
  )
}

export function isMcpConfigInspectionFieldWithinLimit(value: string): boolean {
  return isTextWithinLimits(
    value,
    MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES,
    MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS
  )
}

function isTextWithinLimits(value: string, maxBytes: number, maxCodeUnits: number): boolean {
  return (
    value.length <= maxCodeUnits &&
    !measureUtf8ByteLength(value, { stopAfterBytes: maxBytes }).exceededLimit
  )
}

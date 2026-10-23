import { hasOnlyKeys, isRecord } from './agent-status-child-work-value-guards'
import { isWindowsAbsolutePathLike } from './cross-platform-path'

/** Observed child environment; replay additionally requires host-owned origin admission. */
export type ClaudeResumeConfig =
  | { kind: 'default'; userHome: string }
  | { kind: 'explicit'; value: string; userHome: string }

function isConfigPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  const windows = isWindowsAbsolutePathLike(value)
  const path = windows ? value.replaceAll('\\', '/') : value
  if (
    (!windows && !path.startsWith('/')) ||
    path.startsWith('//?/') ||
    path.startsWith('//./') ||
    path.split('/').some((part) => part === '..' || part === '.')
  ) {
    return false
  }
  if (!windows) {
    return true
  }
  if (!/^[A-Za-z]:\//.test(path) && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(path)) {
    return false
  }
  return path
    .replace(/^[A-Za-z]:\//, '')
    .split('/')
    .every(
      (part) =>
        !/[<>:"|?*]/.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
}

export function normalizeClaudeResumeConfig(value: unknown): ClaudeResumeConfig | undefined {
  if (!isRecord(value) || !isConfigPath(value.userHome)) {
    return undefined
  }
  if (value.kind === 'default' && hasOnlyKeys(value, ['kind', 'userHome'])) {
    return { kind: 'default', userHome: value.userHome }
  }
  if (
    value.kind === 'explicit' &&
    hasOnlyKeys(value, ['kind', 'userHome', 'value']) &&
    isConfigPath(value.value)
  ) {
    return { kind: 'explicit', userHome: value.userHome, value: value.value }
  }
  return undefined
}

export function claudeResumeConfigsEqual(
  left: ClaudeResumeConfig | undefined,
  right: ClaudeResumeConfig | undefined
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.kind === right.kind &&
        left.userHome === right.userHome &&
        (left.kind !== 'explicit' || (right.kind === 'explicit' && left.value === right.value))
}

export function readClaudeHookResumeConfig(
  record: Record<string, unknown>
): ClaudeResumeConfig | undefined {
  if (
    record.claudeConfigKind === 'default' &&
    record.claudeConfigDir !== undefined &&
    record.claudeConfigDir !== ''
  ) {
    return undefined
  }
  return normalizeClaudeResumeConfig({
    kind: record.claudeConfigKind,
    userHome: record.claudeUserHome,
    ...(record.claudeConfigKind === 'explicit' ? { value: record.claudeConfigDir } : {})
  })
}

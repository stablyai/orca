import { unwrapLoginShellCommand } from './native-chat-tool-preview-prefix'
import { normalizeToolInput } from './native-chat-tool-summary'

type NativeChatTextInputKey = 'command' | 'cmd' | 'CommandLine' | 'description' | 'Role' | 'url'
type NativeChatTextInput = Partial<Record<NativeChatTextInputKey, unknown>>

function isNativeChatTextInput(value: unknown): value is NativeChatTextInput {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function nativeChatToolInputText(
  input: unknown,
  key: NativeChatTextInputKey
): string | null {
  let value = input
  if (typeof value === 'string') {
    const raw = value
    try {
      value = JSON.parse(value)
    } catch {
      return key === 'command' ? raw : null
    }
  }
  if (!isNativeChatTextInput(value)) {
    return null
  }
  const field = value[key]
  if (typeof field === 'string') {
    return field
  }
  return (key === 'command' || key === 'cmd') &&
    Array.isArray(field) &&
    field.every((part) => typeof part === 'string')
    ? field.join(' ')
    : null
}

export function nativeChatFullCommand(input: unknown): string | null {
  const command =
    nativeChatToolInputText(input, 'command') ||
    nativeChatToolInputText(input, 'cmd') ||
    nativeChatToolInputText(input, 'CommandLine')
  return command?.trim() ? unwrapLoginShellCommand(command).trim() : null
}

/** A string command whose input contains no other fields or argv structure. */
export function nativeChatPlainCommandInput(input: unknown): string | null {
  const normalized = normalizeToolInput(input)
  if (typeof normalized === 'string') {
    return normalized
  }
  if (!isNativeChatTextInput(normalized)) {
    return null
  }
  const keys = Object.keys(normalized)
  const key = keys[0]
  if (keys.length !== 1 || (key !== 'command' && key !== 'cmd' && key !== 'CommandLine')) {
    return null
  }
  const command = normalized[key]
  return typeof command === 'string' ? command : null
}

import { closeSync, openSync, readSync, statSync } from 'node:fs'

export const CLAUDE_TASK_NOTIFICATION_MARKER = '<task-notification>'
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/
const TASK_STATUS_PATTERN = /<status>([a-z_]+)<\/status>/
const TRANSCRIPT_SCAN_BYTES = 4 * 1024 * 1024
const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
  'cancelled',
  'canceled',
  'timed_out'
])

/** Read terminal Claude task notifications from the bounded transcript tail. */
export function readClaudeTerminalTaskNotificationIds(transcriptPath: unknown): Set<string> {
  return new Set(
    readClaudeTerminalTaskNotificationsInternal(transcriptPath, 0, false).map(
      ({ taskId }) => taskId
    )
  )
}

export type ClaudeTerminalTaskNotification = {
  taskId: string
  status: string
  byteOffset: number
}

export function readClaudeTerminalTaskNotifications(
  transcriptPath: unknown,
  minimumByteOffset = 0
): ClaudeTerminalTaskNotification[] {
  return readClaudeTerminalTaskNotificationsInternal(transcriptPath, minimumByteOffset, true)
}

function readClaudeTerminalTaskNotificationsInternal(
  transcriptPath: unknown,
  minimumByteOffset: number,
  requireProviderDelivery: boolean
): ClaudeTerminalTaskNotification[] {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return []
  }
  try {
    const size = statSync(transcriptPath).size
    if (size <= 0 || minimumByteOffset >= size) {
      return []
    }
    const requestedStart = Math.max(0, minimumByteOffset)
    const length = Math.min(size - requestedStart, TRANSCRIPT_SCAN_BYTES)
    const start = size - length
    const buffer = Buffer.alloc(length)
    const fd = openSync(transcriptPath, 'r')
    try {
      let filled = 0
      while (filled < length) {
        const count = readSync(fd, buffer, filled, length - filled, start + filled)
        if (count === 0) {
          break
        }
        filled += count
      }
      if (filled !== length) {
        return []
      }
    } finally {
      closeSync(fd)
    }
    let lineStart = start === 0 || start === requestedStart ? 0 : buffer.indexOf(0x0a) + 1
    if (lineStart === 0 && start > 0 && start !== requestedStart) {
      return []
    }
    const notifications: ClaudeTerminalTaskNotification[] = []
    while (lineStart < buffer.length) {
      const newline = buffer.indexOf(0x0a, lineStart)
      const lineEnd = newline === -1 ? buffer.length : newline
      const line = buffer.subarray(lineStart, lineEnd).toString('utf8')
      if (!line.includes(CLAUDE_TASK_NOTIFICATION_MARKER)) {
        lineStart = newline === -1 ? buffer.length : newline + 1
        continue
      }
      const notification = parseClaudeTaskNotificationLineInternal(line, requireProviderDelivery)
      if (notification && TERMINAL_TASK_STATUSES.has(notification.status)) {
        notifications.push({ ...notification, byteOffset: start + lineStart })
      }
      lineStart = newline === -1 ? buffer.length : newline + 1
    }
    return notifications
  } catch {
    return []
  }
}

export function parseClaudeTaskNotificationLine(
  line: string
): { taskId: string; status: string } | null {
  return parseClaudeTaskNotificationLineInternal(line, true)
}

/** Preserve historical queue-record support for view-only transcript status. */
export function parseClaudeTaskNotificationLineForDisplay(
  line: string
): { taskId: string; status: string } | null {
  return parseClaudeTaskNotificationLineInternal(line, false)
}

function parseClaudeTaskNotificationLineInternal(
  line: string,
  requireProviderDelivery: boolean
): { taskId: string; status: string } | null {
  const notification = taskNotificationText(line, requireProviderDelivery)
  if (
    !notification.startsWith(CLAUDE_TASK_NOTIFICATION_MARKER) ||
    !notification.endsWith('</task-notification>')
  ) {
    return null
  }
  const taskId = TASK_ID_PATTERN.exec(notification)?.[1]?.trim()
  const status = TASK_STATUS_PATTERN.exec(notification)?.[1]
  return taskId && status ? { taskId, status } : null
}

function taskNotificationText(line: string, requireProviderDelivery: boolean): string {
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return ''
    }
    const record = parsed as Record<string, unknown>
    if (requireProviderDelivery) {
      const origin =
        record.origin && typeof record.origin === 'object'
          ? (record.origin as Record<string, unknown>)
          : undefined
      if (
        record.type !== 'user' ||
        record.promptSource !== 'system' ||
        origin?.kind !== 'task-notification'
      ) {
        return ''
      }
    } else if (typeof record.content === 'string') {
      return record.content.trim()
    }
    if (!record.message || typeof record.message !== 'object') {
      return ''
    }
    const content = (record.message as Record<string, unknown>).content
    if (typeof content === 'string') {
      return content.trim()
    }
    return Array.isArray(content)
      ? content.map(taskNotificationBlockText).filter(Boolean).join(' ').trim()
      : ''
  } catch {
    return ''
  }
}

function taskNotificationBlockText(block: unknown): string {
  if (typeof block === 'string') {
    return block
  }
  if (!block || typeof block !== 'object') {
    return ''
  }
  const record = block as Record<string, unknown>
  return typeof record.text === 'string'
    ? record.text
    : typeof record.content === 'string'
      ? record.content
      : ''
}

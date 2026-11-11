import { open, type FileHandle } from 'node:fs/promises'
import {
  CLAUDE_TASK_NOTIFICATION_MARKER,
  readClaudeTaskNotification
} from './claude-task-notification-text'

const CLAUDE_TASK_NOTIFICATION_SCAN_LIMIT_BYTES = 4 * 1024 * 1024
const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
  'cancelled',
  'canceled',
  'timed_out'
])

export type ClaudeTaskTranscriptPosition = {
  sessionId: string
  transcriptPath: string
  fileIdentity: string
  byteOffset: number
}

export type ClaudeTerminalTaskNotification = {
  taskId: string
  byteOffset: number
}

export type ClaudeTaskTranscriptObservation = ClaudeTaskTranscriptPosition & {
  kind: 'agent' | 'non-agent'
}

export type ClaudeTaskNotificationTranscriptRead =
  | { available: true; notifications: ClaudeTerminalTaskNotification[] }
  | { available: false }

export type ClaudeCurrentTaskNotificationTranscriptRead =
  | {
      available: true
      fileIdentity: string
      notifications: ClaudeTerminalTaskNotification[]
    }
  | { available: false }

export type ClaudeTaskNotificationTranscriptEvidence = {
  position?: ClaudeTaskTranscriptPosition
  current?: ClaudeCurrentTaskNotificationTranscriptRead
}

export async function readClaudeTaskTranscriptPosition(
  sessionId: string | undefined,
  transcriptPath: string | undefined
): Promise<ClaudeTaskTranscriptPosition | undefined> {
  if (!sessionId || !transcriptPath) {
    return undefined
  }
  let file: FileHandle | undefined
  try {
    file = await open(transcriptPath, 'r')
    const stats = await file.stat()
    if (!stats.isFile()) {
      return undefined
    }
    return {
      sessionId,
      transcriptPath,
      fileIdentity: `${stats.dev}:${stats.ino}`,
      byteOffset: stats.size
    }
  } catch {
    return undefined
  } finally {
    if (file) {
      await file.close()
    }
  }
}

export async function readClaudeTerminalTaskNotifications(
  position: ClaudeTaskTranscriptPosition,
  minimumByteOffset: number
): Promise<ClaudeTaskNotificationTranscriptRead> {
  let file: FileHandle | undefined
  try {
    file = await open(position.transcriptPath, 'r')
    const stats = await file.stat()
    const fileIdentity = `${stats.dev}:${stats.ino}`
    if (!stats.isFile() || fileIdentity !== position.fileIdentity) {
      return { available: false }
    }
    return await readNotificationsFromFile(file, stats.size, position.sessionId, minimumByteOffset)
  } catch {
    return { available: false }
  } finally {
    if (file) {
      await file.close()
    }
  }
}

export async function readClaudeCurrentTaskNotifications(
  sessionId: string,
  transcriptPath: string,
  observations: readonly [string, ClaudeTaskTranscriptObservation][]
): Promise<ClaudeCurrentTaskNotificationTranscriptRead> {
  let file: FileHandle | undefined
  try {
    file = await open(transcriptPath, 'r')
    const stats = await file.stat()
    if (!stats.isFile()) {
      return { available: false }
    }
    const fileIdentity = `${stats.dev}:${stats.ino}`
    const matching = observations.filter(
      ([, observation]) =>
        observation.sessionId === sessionId &&
        observation.transcriptPath === transcriptPath &&
        observation.fileIdentity === fileIdentity
    )
    if (matching.length === 0) {
      return { available: true, fileIdentity, notifications: [] }
    }
    const minimumByteOffset = Math.min(...matching.map(([, observation]) => observation.byteOffset))
    const read = await readNotificationsFromFile(file, stats.size, sessionId, minimumByteOffset)
    return read.available ? { ...read, fileIdentity } : read
  } catch {
    return { available: false }
  } finally {
    if (file) {
      await file.close()
    }
  }
}

async function readNotificationsFromFile(
  file: FileHandle,
  fileSize: number,
  sessionId: string,
  minimumByteOffset: number
): Promise<ClaudeTaskNotificationTranscriptRead> {
  const startByteOffset = Math.max(
    minimumByteOffset,
    fileSize - CLAUDE_TASK_NOTIFICATION_SCAN_LIMIT_BYTES
  )
  const length = fileSize - startByteOffset
  if (minimumByteOffset < 0 || minimumByteOffset > fileSize || length < 0) {
    return { available: false }
  }
  const bytes = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead: count } = await file.read(
      bytes,
      filled,
      length - filled,
      startByteOffset + filled
    )
    if (count === 0) {
      return { available: false }
    }
    filled += count
  }
  const notifications: ClaudeTerminalTaskNotification[] = []
  let lineStart = 0
  if (startByteOffset > 0) {
    const previousByte = Buffer.alloc(1)
    const { bytesRead: previousCount } = await file.read(previousByte, 0, 1, startByteOffset - 1)
    if (previousCount !== 1) {
      return { available: false }
    }
    if (previousByte[0] !== 0x0a) {
      const firstNewline = bytes.indexOf(0x0a)
      if (firstNewline === -1) {
        return { available: true, notifications }
      }
      lineStart = firstNewline + 1
    }
  }
  while (lineStart < bytes.length) {
    const newline = bytes.indexOf(0x0a, lineStart)
    if (newline === -1) {
      break
    }
    const line = bytes.subarray(lineStart, newline).toString('utf8')
    const notification = line.includes(CLAUDE_TASK_NOTIFICATION_MARKER)
      ? readProviderTaskNotification(line, sessionId)
      : undefined
    if (notification) {
      notifications.push({
        taskId: notification.taskId,
        byteOffset: startByteOffset + lineStart
      })
    }
    lineStart = newline + 1
  }
  return { available: true, notifications }
}

function readProviderTaskNotification(
  line: string,
  sessionId: string
): { taskId: string } | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.type !== 'user' || value.promptSource !== 'system') {
    return undefined
  }
  const origin = value.origin
  if (!isRecord(origin) || origin.kind !== 'task-notification' || value.sessionId !== sessionId) {
    return undefined
  }
  const message = value.message
  if (!isRecord(message)) {
    return undefined
  }
  const content = message.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(isRecord)
            .map((block) => (typeof block.text === 'string' ? block.text : ''))
            .join('')
        : ''
  const notification = readClaudeTaskNotification(text)
  return notification?.status && TERMINAL_TASK_STATUSES.has(notification.status)
    ? { taskId: notification.taskId }
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

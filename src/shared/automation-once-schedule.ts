export type ParsedOnceSchedule = { kind: 'once'; runAt: number }

const ONCE_PREFIX = 'ONCE='

export function parseAutomationOnceSchedule(schedule: string): ParsedOnceSchedule | null {
  const expression = schedule.trim()
  if (!expression.startsWith(ONCE_PREFIX)) {
    return null
  }
  const value = expression.slice(ONCE_PREFIX.length)
  const runAt = Date.parse(value)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value) ||
    !Number.isFinite(runAt) ||
    new Date(runAt).toISOString() !== value
  ) {
    throw new Error('Invalid one-time automation date and time.')
  }
  return { kind: 'once', runAt }
}

export function buildAutomationOnceSchedule(runAt: number): string {
  const expression = `${ONCE_PREFIX}${new Date(runAt).toISOString()}`
  parseAutomationOnceSchedule(expression)
  return expression
}

export function automationOnceDateInput(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function automationOnceRunAt(date: string, time: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return null
  }
  const timestamp = new Date(`${date}T${time}:00`).getTime()
  const local = new Date(timestamp)
  // Date normalizes invalid calendar dates and clock times skipped by daylight saving.
  return Number.isFinite(timestamp) &&
    automationOnceDateInput(timestamp) === date &&
    local.getHours() === Number(time.slice(0, 2)) &&
    local.getMinutes() === Number(time.slice(3))
    ? timestamp
    : null
}

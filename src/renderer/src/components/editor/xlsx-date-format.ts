import { formatXlsxSerialDate, type XlsxDateSystem } from './xlsx-serial-date'

/**
 * Renders a date serial the way the workbook's own format code asks for.
 *
 * Why not always ISO: `d\-m` means `26-5` and `dd/mm/yyyy` means `01/01/2025`. A
 * viewer that prints an ISO date regardless is readable but is not what the author
 * wrote, and on a chart axis it was showing the raw serial instead.
 */
export type XlsxDateFormatOptions = XlsxDateSystem & { locale: string }

// Longest first, so `yyyy` is not read as two `yy` and `mmm` not as `mm` + `m`.
const DATE_TOKENS = [
  'yyyy',
  'yy',
  'mmmm',
  'mmm',
  'mm',
  'm',
  'dddd',
  'ddd',
  'dd',
  'd',
  'hh',
  'h',
  'ss',
  's',
  'am/pm',
  'a/p'
] as const

const MILLISECONDS_PER_DAY = 86_400_000
const DAY_ZERO_1900_UTC = Date.UTC(1899, 11, 30)
const DAY_ZERO_1900_PRE_LEAP_BUG_UTC = Date.UTC(1899, 11, 31)
const DAY_ZERO_1904_UTC = Date.UTC(1904, 0, 1)
const PHANTOM_LEAP_DAY_SERIAL = 60

export function formatXlsxDate(
  serial: number,
  formatCode: string,
  options: XlsxDateFormatOptions
): string | null {
  const parts = readDateParts(serial, options)
  if (parts === null) {
    // Why: the phantom 1900 leap day has no real date behind it, so the ISO
    // fallback keeps reporting what Excel stores rather than inventing one.
    return formatXlsxSerialDate(serial, options)
  }

  const tokens = tokenizeFormatCode(formatCode)
  if (!tokens.some((token) => token.isToken)) {
    return formatXlsxSerialDate(serial, options)
  }
  const usesTwelveHourClock = tokens.some(
    (token) => token.isToken && (token.text === 'am/pm' || token.text === 'a/p')
  )

  return tokens
    .map((token, index) =>
      token.isToken
        ? renderToken(token.text, parts, {
            ...options,
            usesTwelveHourClock,
            isMinute: isMinuteToken(tokens, index)
          })
        : token.text
    )
    .join('')
}

type FormatToken = { text: string; isToken: boolean }

function tokenizeFormatCode(formatCode: string): FormatToken[] {
  const tokens: FormatToken[] = []
  let index = 0

  while (index < formatCode.length) {
    const char = formatCode[index]!
    if (char === '\\') {
      tokens.push({ text: formatCode[index + 1] ?? '', isToken: false })
      index += 2
      continue
    }
    if (char === '"') {
      const end = formatCode.indexOf('"', index + 1)
      tokens.push({
        text: formatCode.slice(index + 1, end === -1 ? undefined : end),
        isToken: false
      })
      index = end === -1 ? formatCode.length : end + 1
      continue
    }
    if (char === '[') {
      // Why: a bracket section is a colour or a locale hint, never a date part.
      const end = formatCode.indexOf(']', index + 1)
      index = end === -1 ? formatCode.length : end + 1
      continue
    }
    const lower = formatCode.slice(index).toLowerCase()
    const token = DATE_TOKENS.find((candidate) => lower.startsWith(candidate))
    if (token !== undefined) {
      tokens.push({ text: token, isToken: true })
      index += token.length
      continue
    }
    tokens.push({ text: char, isToken: false })
    index += 1
  }

  return tokens
}

// Why: `m` is a month or a minute depending on what surrounds it — a minute when
// it follows an hour or precedes a second, which is the rule Excel applies.
function isMinuteToken(tokens: FormatToken[], index: number): boolean {
  const token = tokens[index]
  if (token === undefined || (token.text !== 'm' && token.text !== 'mm')) {
    return false
  }
  const previous = findNeighbourToken(tokens, index, -1)
  const next = findNeighbourToken(tokens, index, 1)
  return previous === 'h' || previous === 'hh' || next === 's' || next === 'ss'
}

function findNeighbourToken(
  tokens: FormatToken[],
  index: number,
  step: number
): string | undefined {
  for (let cursor = index + step; cursor >= 0 && cursor < tokens.length; cursor += step) {
    if (tokens[cursor]!.isToken) {
      return tokens[cursor]!.text
    }
  }
  return undefined
}

type DateParts = { date: Date; secondsOfDay: number }

function readDateParts(serial: number, options: XlsxDateSystem): DateParts | null {
  if (!Number.isFinite(serial) || serial < 0) {
    return null
  }
  const days = Math.floor(serial)
  if (days === PHANTOM_LEAP_DAY_SERIAL && !options.use1904DateSystem) {
    return null
  }
  const dayZeroUtc = options.use1904DateSystem
    ? DAY_ZERO_1904_UTC
    : days < PHANTOM_LEAP_DAY_SERIAL
      ? DAY_ZERO_1900_PRE_LEAP_BUG_UTC
      : DAY_ZERO_1900_UTC
  const date = new Date(dayZeroUtc + days * MILLISECONDS_PER_DAY)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return { date, secondsOfDay: Math.round((serial - days) * 86_400) }
}

function renderToken(
  token: string,
  { date, secondsOfDay }: DateParts,
  options: XlsxDateFormatOptions & { usesTwelveHourClock: boolean; isMinute: boolean }
): string {
  const hours = Math.floor(secondsOfDay / 3600)
  switch (token) {
    case 'yyyy': {
      return String(date.getUTCFullYear()).padStart(4, '0')
    }
    case 'yy': {
      return String(date.getUTCFullYear() % 100).padStart(2, '0')
    }
    case 'mmmm':
    case 'mmm': {
      return new Intl.DateTimeFormat(options.locale, {
        month: token === 'mmmm' ? 'long' : 'short',
        timeZone: 'UTC'
      }).format(date)
    }
    case 'dddd':
    case 'ddd': {
      return new Intl.DateTimeFormat(options.locale, {
        weekday: token === 'dddd' ? 'long' : 'short',
        timeZone: 'UTC'
      }).format(date)
    }
    case 'mm': {
      return options.isMinute
        ? String(Math.floor((secondsOfDay % 3600) / 60)).padStart(2, '0')
        : String(date.getUTCMonth() + 1).padStart(2, '0')
    }
    case 'm': {
      return options.isMinute
        ? String(Math.floor((secondsOfDay % 3600) / 60))
        : String(date.getUTCMonth() + 1)
    }
    case 'dd': {
      return String(date.getUTCDate()).padStart(2, '0')
    }
    case 'd': {
      return String(date.getUTCDate())
    }
    case 'hh': {
      return String(toDisplayHours(hours, options.usesTwelveHourClock)).padStart(2, '0')
    }
    case 'h': {
      return String(toDisplayHours(hours, options.usesTwelveHourClock))
    }
    case 'ss': {
      return String(secondsOfDay % 60).padStart(2, '0')
    }
    case 's': {
      return String(secondsOfDay % 60)
    }
    case 'am/pm': {
      return hours < 12 ? 'AM' : 'PM'
    }
    case 'a/p': {
      return hours < 12 ? 'A' : 'P'
    }
    default: {
      return token
    }
  }
}

function toDisplayHours(hours: number, usesTwelveHourClock: boolean): number {
  if (!usesTwelveHourClock) {
    return hours
  }
  const twelveHour = hours % 12
  return twelveHour === 0 ? 12 : twelveHour
}

// Lays a run of daily usage levels out as a contributions-style grid: one column per week,
// Sunday at the top, so a day keeps its row from week to week. Pure for tests and fixtures.

export type HeatmapCell = {
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  level: number
  /** Index into the server's per-day arrays. */
  index: number
}

export type HeatmapLayout = {
  /** weeks[w][weekday]: null pads before the first day and after today. */
  weeks: (HeatmapCell | null)[][]
  /** Column index where each month first appears (for the labels above the grid). */
  months: { week: number; month: number; year: number }[]
}

const DAY_MS = 86_400_000

function parseIsoDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

export function layoutHeatmap(start: string, levels: readonly number[]): HeatmapLayout {
  const first = parseIsoDate(start)
  const lead = new Date(first).getUTCDay()
  const total = lead + levels.length
  const weeks: (HeatmapCell | null)[][] = []
  for (let slot = 0; slot < Math.ceil(total / 7) * 7; slot++) {
    const index = slot - lead
    const week = Math.floor(slot / 7)
    weeks[week] ??= []
    weeks[week].push(
      index >= 0 && index < levels.length
        ? {
            date: new Date(first + index * DAY_MS).toISOString().slice(0, 10),
            level: levels[index]!,
            index
          }
        : null
    )
  }
  const months: HeatmapLayout['months'] = []
  weeks.forEach((days, week) => {
    const firstDay = days.find((cell) => cell !== null)
    if (!firstDay) {
      return
    }
    const date = new Date(parseIsoDate(firstDay.date))
    const month = date.getUTCMonth()
    const last = months.at(-1)
    if (!last || last.month !== month) {
      months.push({ week, month, year: date.getUTCFullYear() })
    }
  })
  // A label squeezed into the first partial column would collide with the next one.
  if (months.length > 1 && months[1]!.week - months[0]!.week < 2) {
    months.shift()
  }
  return { weeks, months }
}

/** The viewer's UTC offset in minutes (east positive), the way the control plane expects it. */
export function localUtcOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset()
}

/** A YYYY-MM-DD calendar date as a Date at local noon, for formatting without a day shift. */
export function calendarDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d!, 12)
}

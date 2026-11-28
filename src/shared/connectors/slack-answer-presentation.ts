import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const CONNECTOR_SLACK_PRESENTATION_FEATURE = 'slack.answerPresentation'
export const CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE = 'slack.answerPresentation.text'
export const CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE = 'slack.answerPresentation.turnEnd'
export const CONNECTOR_SLACK_PRESENTATION_EVENTS_PATH = '/v1/connector/presented-events'
export const CONNECTOR_SLACK_PRESENTATION_REPLIES_PATH = '/v1/connector/presented-replies'
export const CONNECTOR_SLACK_PRESENTATION_BOT_POSTS_PATH = '/v1/connector/presented-bot-posts'
export const CONNECTOR_SLACK_PRESENTATION_ACTIONS_PATH = '/v1/connector/presented-actions'
/** A rollback can still verify and deliver a prepared answer as text. */
export function takesSlackAnswerPresentation(features: ReadonlySet<string> | null): boolean {
  return (
    features?.has(CONNECTOR_SLACK_PRESENTATION_FEATURE) === true ||
    features?.has(CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE) === true
  )
}

export const SLACK_PRESENTATION_POST_VERSION = 2
export const SLACK_PRESENTATION_EVENT_VERSION = 3
export const SLACK_PRESENTATION_TURN_END_VERSION = 4
export const SLACK_PRESENTATION_UNCONFIRMED =
  'I couldn’t confirm that the details of this answer can be shared here.'
export const SLACK_ANSWER_MAX_BYTES = 12 * 1024
export const SLACK_ANSWER_MAX_TEXT = 3_000
// Older connector revisions cap ordinary answer prose at 8 KiB.
const MAX_PROJECTED_BYTES = 8 * 1024

// A presentation is literal text. An independently authorized source link can be
// rendered by the posting adapter, but the author cannot supply a URL or Slack markup.
const UNSAFE_TEXT = /[<>`@]|\p{Cf}|\p{Cs}|:\/\/|\b(?:javascript:|data:|mailto:|www\.)|\]\s*\(/iu
const CONTROL = /\p{Cc}/u
// Data-file suffixes here are not internet top-level domains.
const SOURCE_FILENAME = /^[a-z0-9][a-z0-9_-]*\.(?:csv|tsv|xlsx|jsonl?)$/iu

function containsDomain(text: string): boolean {
  let labelEndsAt = -1
  let dotEndsAt = -1
  for (const token of text.matchAll(/[a-z\d-]+|\./giu)) {
    const word = token[0]
    if (word === '.') {
      dotEndsAt = labelEndsAt === token.index ? token.index + 1 : -1
      continue
    }
    if (
      dotEndsAt === token.index &&
      /^[a-z]{2,63}\b/iu.test(text.slice(token.index, token.index + 64))
    ) {
      return true
    }
    labelEndsAt = /[a-z\d]/iu.test(word) ? token.index + word.length : -1
  }
  return false
}

function literal(max: number, { multiline = false, source = false } = {}) {
  return z
    .string()
    .refine((text) => text.length > 0 && text.length <= max, { abort: true })
    .refine(
      (text) =>
        text === text.trim() &&
        !UNSAFE_TEXT.test(text) &&
        ((source && SOURCE_FILENAME.test(text)) || !containsDomain(text)) &&
        !CONTROL.test(multiline ? text.replaceAll('\n', '') : text) &&
        (multiline || !text.includes('\n')),
      { message: 'Expected literal text without links, mentions, or control characters' }
    )
}

function distinct(labels: readonly string[]): boolean {
  return (
    new Set(labels.map((label) => label.normalize('NFKC').toLowerCase())).size === labels.length
  )
}

const Presentation = lazyZodSchema(() => {
  // An explicit unit also gives the renderer the label to show alongside each measure.
  const Unit = z.enum([
    'count',
    'percent',
    'ratio',
    'ms',
    's',
    'min',
    'h',
    'days',
    'bytes',
    'KiB',
    'MiB',
    'GiB',
    'requests/s',
    'USD',
    'EUR',
    'GBP'
  ])
  const Label = literal(20)
  const Value = z.number().finite()
  const DateTime = z.iso.datetime({ precision: 0 })
  const Window = z
    .strictObject({ from: DateTime, to: DateTime })
    .refine(({ from, to }) => from < to)
  const Timing = z.union([z.strictObject({ asOf: DateTime }), Window])
  const Frame = { title: literal(50), source: literal(80, { source: true }) }
  const Chart = {
    ...Frame,
    axis: literal(25),
    unit: Unit,
    series: z
      .array(z.strictObject({ label: Label, values: z.array(Value).min(2).max(12) }))
      .min(1)
      .max(2)
  }

  const Line = z.strictObject({
    ...Chart,
    kind: z.literal('line'),
    window: Window,
    // UTC timestamps constrain spacing, and the short labels are the ones both views display.
    points: z
      .array(z.strictObject({ at: DateTime, label: Label }))
      .min(2)
      .max(12)
  })

  const Bar = z.strictObject({
    ...Chart,
    kind: z.literal('bar'),
    timing: Timing.optional(),
    labels: z.array(Label).min(2).max(12)
  })

  const Table = z.strictObject({
    ...Frame,
    kind: z.literal('table'),
    timing: Timing.optional(),
    columns: z
      .array(z.strictObject({ label: Label, unit: Unit.optional() }))
      .min(1)
      .max(4),
    rows: z
      .array(
        z
          .array(z.union([literal(60), Value]))
          .min(1)
          .max(4)
      )
      .min(1)
      .max(8)
  })

  const Visual = z.discriminatedUnion('kind', [Line, Bar, Table]).refine(
    (visual) => {
      if (visual.kind === 'table') {
        return (
          !visual.columns[0]?.unit &&
          distinct(visual.columns.map(({ label }) => label)) &&
          visual.rows.every((row) => row.length === visual.columns.length) &&
          visual.columns.every((column, index) =>
            visual.rows.every((row) => typeof row[index] === (column.unit ? 'number' : 'string'))
          ) &&
          distinct(visual.rows.map((row) => String(row[0])))
        )
      }
      const labels =
        visual.kind === 'line' ? visual.points.map(({ label }) => label) : visual.labels
      if (
        !distinct(labels) ||
        !distinct(visual.series.map(({ label }) => label)) ||
        !visual.series.every(({ values }) => values.length === labels.length)
      ) {
        return false
      }
      if (visual.kind === 'bar') {
        return true
      }
      const stamps = visual.points.map(({ at }) => Date.parse(at))
      const step = stamps[1]! - stamps[0]!
      return (
        step > 0 &&
        stamps[0]! >= Date.parse(visual.window.from) &&
        stamps.at(-1)! <= Date.parse(visual.window.to) &&
        stamps.every((stamp, index) => stamp === stamps[0]! + index * step)
      )
    },
    { message: 'Expected unique labels and complete values on a common scale' }
  )

  return z.strictObject({
    v: z.literal(1),
    text: literal(SLACK_ANSWER_MAX_TEXT, { multiline: true }),
    visual: Visual.optional()
  })
})

export type SlackAnswerPresentation = z.infer<typeof Presentation>

export const SlackAnswerPresentationSchema = lazyZodSchema(() =>
  Presentation.refine(
    (answer) => {
      const encoder = new TextEncoder()
      const text = slackAnswerText(answer)
      return (
        text.length <= SLACK_ANSWER_MAX_TEXT &&
        encoder.encode(text).byteLength <= MAX_PROJECTED_BYTES &&
        encoder.encode(JSON.stringify(answer)).byteLength <= SLACK_ANSWER_MAX_BYTES
      )
    },
    { message: 'The complete answer and its exact values must fit in one message' }
  )
)

export function slackAnswerText({ text, visual }: SlackAnswerPresentation): string {
  if (!visual) {
    return text
  }
  const timing = visual.kind === 'line' ? visual.window : visual.timing
  const when = timing
    ? 'asOf' in timing
      ? `As of ${timing.asOf}`
      : `${timing.from} to ${timing.to}`
    : ''
  const axis = visual.kind === 'table' ? '' : `Categories: ${visual.axis}`
  return `${text}\n\n${[visual.title, `Source: ${visual.source}`, when, axis, ...valueLines(visual)].filter(Boolean).join('\n')}`
}

function valueLines(visual: NonNullable<SlackAnswerPresentation['visual']>): string[] {
  if (visual.kind === 'table') {
    return visual.rows.map((row) =>
      row
        .map((value, index) => {
          const column = visual.columns[index]!
          return `${column.label}: ${value}${column.unit ? ` ${column.unit}` : ''}`
        })
        .join(', ')
    )
  }
  const labels = visual.kind === 'line' ? visual.points.map(({ label }) => label) : visual.labels
  return labels.map((label, index) => {
    const values = visual.series.map(
      ({ label: series, values }) => `${series} ${values[index]} ${visual.unit}`
    )
    return `${label}: ${values.join(', ')}`
  })
}

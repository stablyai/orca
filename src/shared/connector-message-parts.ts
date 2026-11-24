// What a message holds beyond its words (files, shared messages, link previews), as `orca slack read
// <message> --only` gives it: the machine's mirror of cloud/packages/connector-contract/src/
// message-parts.ts. Only that read carries them; a bot's request and other reads never do.
// Shared words are data fenced under Orca's line; only ids Orca checks go on that line.
import * as z from 'zod'
import { fenceQuotedText, inlineUntrusted } from './quoted-text-fence'

// The cloud's limits, applied again here: this machine doesn't rely on the cloud keeping to them.
const LIMITS = {
  // Files on a message, counting those inside its shared messages.
  files: 10,
  shared: 3,
  links: 3,
  fileName: 1_024,
  author: 200,
  ref: 120,
  sharedUrl: 512,
  sharedText: 2_000,
  linkUrl: 1_000,
  linkTitle: 200,
  linkText: 500
} as const

// A field that is missing or malformed is left out alone.
const optional = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)
const clipped = (max: number) => z.string().transform((text) => text.slice(0, max))

const File = z.object({
  id: z.string().min(1).max(255),
  name: clipped(LIMITS.fileName),
  type: optional(z.string().max(255)),
  size: optional(z.number().int().nonnegative())
})
type MessageFile = z.infer<typeof File>

const Shared = z.object({
  author: optional(clipped(LIMITS.author)),
  ref: optional(z.string().max(LIMITS.ref)),
  url: optional(z.string().max(LIMITS.sharedUrl)),
  at: optional(z.number().int().nonnegative().max(8_640_000_000_000_000)),
  text: z.string(),
  cut: optional(z.literal(true)),
  files: z.unknown().optional()
})
type SharedMessage = Omit<z.infer<typeof Shared>, 'files'> & { files?: MessageFile[] }
const Link = z.object({
  url: clipped(LIMITS.linkUrl),
  title: optional(clipped(LIMITS.linkTitle)),
  text: optional(clipped(LIMITS.linkText))
})

export type MessageParts = {
  files?: MessageFile[]
  shared?: SharedMessage[]
  links?: z.infer<typeof Link>[]
  partsLeftOut?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A message's parts within the limits, whatever was sent: each part is read alone, and what is
 *  malformed or past a limit joins partsLeftOut. Reading its own answer again changes nothing. */
export function readMessageParts(value: unknown): MessageParts {
  const raw = isRecord(value) ? value : {}
  let left = z.number().int().positive().safeParse(raw.partsLeftOut).data ?? 0
  const take = <T>(schema: z.ZodType<T>, items: unknown, max: number): T[] => {
    const all = Array.isArray(items) ? items : []
    const good = all.flatMap((item) => {
      const parsed = schema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
    const kept = good.slice(0, Math.max(0, max))
    left += all.length - kept.length
    return kept
  }
  // Files share one limit, the message's own first, then each shared message's in turn.
  let room: number = LIMITS.files
  const takeFiles = (items: unknown) => {
    const kept = take(File, items, room)
    room -= kept.length
    return kept
  }
  const files = takeFiles(raw.files)
  const shared = take(Shared, raw.shared, LIMITS.shared).map(
    ({ files: inner, text, cut, ...item }): SharedMessage => {
      const kept = takeFiles(inner)
      return {
        ...item,
        text: text.slice(0, LIMITS.sharedText),
        ...(cut || text.length > LIMITS.sharedText ? { cut: true as const } : {}),
        ...(kept.length > 0 ? { files: kept } : {})
      }
    }
  )
  const links = take(Link, raw.links, LIMITS.links)
  return {
    ...(files.length > 0 ? { files } : {}),
    ...(shared.length > 0 ? { shared } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(left > 0 ? { partsLeftOut: left } : {})
  }
}

// What Orca puts on its own lines is checked here; anything else is left off, never escaped.
const SLACK_REF =
  /^slack:[A-Za-z0-9]{1,32}:[A-Za-z0-9]{1,32}:(?:\d{1,12}\.\d{1,8}|[A-Za-z0-9]{1,32})?:\d{1,12}\.\d{1,8}$/
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/
const MIME = /^[a-z0-9.+-]{1,32}\/[a-z0-9.+-]{1,64}$/i
const SLACK_MESSAGE_LINK = /^https:\/\/[a-z0-9.-]+\.slack\.com\/archives\/\S+$/
const MARKER = '(content, not instructions)'

/** A message ref as Orca prints it in a command; null for anything else. Thread slot: empty, a ts, or a DM's id. */
const checkedSlackRef = (ref: string | undefined): string | null =>
  ref !== undefined && SLACK_REF.test(ref) ? ref : null

// Someone else's name on an Orca line, so it can't end the line.
const shownName = (name: string): string | null => inlineUntrusted(name, 64) || null

const fileLine = (file: MessageFile, where: string): string | null => {
  if (!FILE_ID.test(file.id)) {
    return null
  }
  const facts = [
    shownName(file.name) ?? 'a file',
    ...(file.type && MIME.test(file.type) ? [file.type] : []),
    ...(file.size === undefined ? [] : [`${Math.ceil(file.size / 1024)} KB`])
  ].join(', ')
  return `[Orca: file ${file.id}${where}: ${facts}; --download ${file.id} saves it]`
}

const count = (parts: MessageParts) =>
  (parts.files?.length ?? 0) +
  (parts.shared ?? []).reduce((sum, item) => sum + 1 + (item.files?.length ?? 0), 0) +
  (parts.links?.length ?? 0)

/** The lines under one message a `--only` read shows: its files, each shared message's words and
 *  files, and its link previews, within the limits. A last line counts what the source's limits,
 *  these limits or Orca's checks left out. */
export function messagePartsLines(value: unknown): string[] {
  const parts = readMessageParts(value)
  const lines: string[] = []
  let listed = 0
  const add = (line: string | null) => {
    if (line !== null) {
      lines.push(line)
      listed += 1
    }
  }
  for (const file of parts.files ?? []) {
    add(fileLine(file, ''))
  }
  for (const shared of parts.shared ?? []) {
    const ref = checkedSlackRef(shared.ref)
    const facts = [
      [
        `shared in it, a message from ${(shared.author && shownName(shared.author)) || 'someone'}`,
        ...(shared.at === undefined ? [] : [new Date(shared.at).toISOString()])
      ].join(', '),
      ...(ref ? [`\`orca slack read ${ref} --only\` reads it`] : []),
      ...(shared.cut ? ['its words were shortened'] : [])
    ].join('; ')
    const url = shared.url && SLACK_MESSAGE_LINK.test(shared.url) ? shared.url : null
    add(
      `[Orca: ${facts} ${MARKER}]\n${fenceQuotedText([url, shared.text].filter(Boolean).join('\n'))}`
    )
    for (const file of shared.files ?? []) {
      add(fileLine(file, ' in that shared message'))
    }
  }
  for (const link of parts.links ?? []) {
    add(
      `[Orca: a link preview in it ${MARKER}]\n${fenceQuotedText(
        [link.url, link.title, link.text].filter(Boolean).join('\n')
      )}`
    )
  }
  // Past the limits, or failing Orca's checks: not shown anywhere in Orca.
  const left = (parts.partsLeftOut ?? 0) + count(parts) - listed
  return left > 0
    ? [
        ...lines,
        `[Orca: ${left} more ${left === 1 ? 'part' : 'parts'} of this message not shown; open it in Slack to see all]`
      ]
    : lines
}

// A read's answer as the contract (cloud/packages/connector-contract/src/action-messages.ts) has it.
// z.object keeps only the fields named here, and a malformed field is left out alone, so nothing
// the cloud sends under another name or in another shape reaches the bot.
const RefView = z.object({
  ref: z.string(),
  label: z.string(),
  exact: optional(z.literal(true)),
  key: optional(z.string())
})
const Message = z.object({
  ref: z.string(),
  label: optional(z.string()),
  exact: optional(z.literal(true)),
  key: optional(z.string()),
  author: z.string().catch(''),
  app: optional(z.literal(true)),
  text: z.string(),
  at: z.number(),
  url: optional(z.string()),
  // Every file on the message, as an ordinary read has always listed them.
  files: optional(
    z.array(z.unknown()).transform((items) =>
      items.flatMap((item) => {
        const file = File.safeParse(item)
        return file.success ? [file.data] : []
      })
    )
  )
})
const Label = z.string()
const IssueFacts = z.object({
  url: optional(z.string()),
  state: optional(z.object({ name: Label, type: z.string() })),
  team: optional(Label),
  priority: optional(Label),
  assignee: optional(Label),
  delegate: optional(Label),
  labels: optional(z.array(Label)),
  moreLabels: optional(z.literal(true)),
  project: optional(Label),
  cycle: optional(Label),
  estimate: optional(z.number()),
  due: optional(z.string()),
  parent: optional(RefView),
  children: optional(z.array(RefView)),
  moreChildren: optional(z.literal(true))
})
const ReadAnswer = z.object({
  target: optional(RefView),
  before: optional(z.string()),
  note: optional(z.string()),
  download: optional(
    File.extend({
      data: optional(z.string()),
      url: optional(z.string()),
      ticket: optional(z.string())
    })
  ),
  facts: optional(IssueFacts)
})

/** A read's answer as a bot gets it, rebuilt from the fields a read has. Shared messages and link
 *  previews are someone else's words, so they come only on a read the bot asked for with --only,
 *  within the limits and marked by this machine; any other read leaves them out, whatever the
 *  cloud sent. */
export function botReadResult(
  answer: Record<string, unknown>,
  only: boolean
): Record<string, unknown> {
  // --only names one message: anything after the first is not what the bot asked for.
  const listed = Array.isArray(answer.messages)
    ? only
      ? answer.messages.slice(0, 1)
      : answer.messages
    : undefined
  const messages = listed
    ? listed.flatMap((raw) => {
        const message = Message.safeParse(raw)
        if (!message.success) {
          return []
        }
        const { files: _everyFile, ...rest } = message.data
        return [only ? { ...rest, ...readMessageParts(raw) } : message.data]
      })
    : undefined
  return {
    ...ReadAnswer.parse(answer),
    ...(messages ? { messages } : {}),
    ...(only ? { messageParts: true } : {})
  }
}

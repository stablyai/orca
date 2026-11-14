import type { OrchestrationMailMessage } from './agent-session-message-source'

function fencedPayload(text: string): string {
  let length = 3
  for (const match of text.matchAll(/`+/g)) {
    length = Math.max(length, match[0].length + 1)
  }
  const fence = '`'.repeat(length)
  return `${fence}\n${text}\n${fence}`
}

/** Historical envelopes are fixed here so later agent-instruction changes cannot change the cut. */
function historicalMailText(text: string, mail: OrchestrationMailMessage): string | undefined {
  const headerEnd = text.indexOf('\n')
  const prefix = `──── From: ${mail.from.toUpperCase()} (${mail.from})`
  const header = text.slice(0, headerEnd)
  if (
    !header.startsWith(prefix) ||
    !/^(?: \[(?:URGENT|HIGH)\])? \((?:status|dispatch|worker_done|merge_ready|escalation|handoff|decision_gate|question|heartbeat)\) ────$/.test(
      header.slice(prefix.length)
    ) ||
    !text.startsWith('Subject: ', headerEnd + 1) ||
    !text.endsWith(`\n${'─'.repeat(60)}`)
  ) {
    return undefined
  }
  const separatorStart = text.lastIndexOf('\n')
  const replyStart = text.lastIndexOf('\n', separatorStart - 1)
  const reply = text.slice(replyStart + 1, separatorStart)
  const match =
    /^\[Reply: orca(?:-dev|-ide)? orchestration reply --id (\S+)(?: --from \S+)? --body "\.\.\."\]$/.exec(
      reply
    )
  if (match?.[1] !== mail.messageId || replyStart < headerEnd + 10) {
    return undefined
  }
  return text.slice(headerEnd + 1 + 'Subject: '.length, replyStart)
}

export function orchestrationMailDisplayText(
  text: string,
  mail: OrchestrationMailMessage,
  shortened: boolean
): string | undefined {
  if (!mail.content) {
    return historicalMailText(text, mail)
  }
  const parts: string[] = []
  const limit = shortened && text.endsWith('…') ? text.length - 1 : text.length
  let previousEnd = 0
  for (const field of ['subject', 'body', 'payload'] as const) {
    const range = mail.content[field]
    if (!range) {
      continue
    }
    const [start, end] = range
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < previousEnd ||
      end < start ||
      (!shortened && end > limit)
    ) {
      return undefined
    }
    previousEnd = end
    if (start >= limit) {
      continue
    }
    const value = text.slice(start, Math.min(end, limit))
    if (value) {
      parts.push(field === 'payload' ? fencedPayload(value) : value)
    }
  }
  return parts.join('\n\n') + (shortened ? '\n\n…' : '')
}

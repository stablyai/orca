import { useLayoutEffect, useRef } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  AGENT_SESSION_SHELL_COMMAND_MAX_OUTPUT_BYTES,
  type AgentSessionShellOutputChunk
} from '../../../../../shared/rpc-contract/structured-agent-session-shell-command-params'

export const NATIVE_CHAT_SHELL_COLLAPSED_LINES = 12
const CHUNK_LINES = 500
const FOLLOW_SLACK_PX = 24

type NativeChatShellOutputRow = { text: string; stderr: boolean }

export function nativeChatShellOutputRows(
  output: readonly AgentSessionShellOutputChunk[]
): NativeChatShellOutputRow[] {
  const rows: NativeChatShellOutputRow[] = []
  for (const chunk of output) {
    const stderr = chunk.stream === 'stderr'
    chunk.text.split('\n').forEach((piece, index) => {
      const last = rows.at(-1)
      if (index === 0 && last) {
        last.stderr = last.text === '' ? stderr : last.stderr || stderr
        last.text += piece
      } else {
        rows.push({ text: piece, stderr })
      }
    })
  }
  if (rows.at(-1)?.text === '') {
    rows.pop()
  }
  return rows
}

function RowGroups({
  rows,
  start
}: {
  rows: readonly NativeChatShellOutputRow[]
  start: number
}): React.JSX.Element {
  const groups: { stderr: boolean; start: number; lines: string[] }[] = []
  rows.forEach((row, offset) => {
    const last = groups.at(-1)
    if (last?.stderr === row.stderr) {
      last.lines.push(row.text)
    } else {
      groups.push({ stderr: row.stderr, start: start + offset, lines: [row.text] })
    }
  })
  return (
    <>
      {groups.map((group) => (
        <span key={group.start} className={cn('block', group.stderr && 'text-chat-warning')}>
          {group.lines.join('\n')}
        </span>
      ))}
    </>
  )
}

export function NativeChatShellRunOutput({
  command,
  rows,
  expanded,
  running,
  error,
  outputTruncated
}: {
  command: string
  rows: readonly NativeChatShellOutputRow[]
  expanded: boolean
  running: boolean
  error?: string
  outputTruncated: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const ref = useRef<HTMLPreElement>(null)
  const following = useRef(true)
  const shown = expanded ? rows : rows.slice(-NATIVE_CHAT_SHELL_COLLAPSED_LINES)
  const chunks = Array.from({ length: Math.ceil(shown.length / CHUNK_LINES) }, (_, index) => ({
    start: index * CHUNK_LINES,
    rows: shown.slice(index * CHUNK_LINES, (index + 1) * CHUNK_LINES)
  }))
  useLayoutEffect(() => {
    const pre = ref.current
    if (pre && running && following.current) {
      pre.scrollTop = pre.scrollHeight
    }
  }, [running, shown])
  return (
    <pre
      ref={ref}
      onScroll={(event) => {
        const pre = event.currentTarget
        following.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < FOLLOW_SLACK_PX
      }}
      className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-chat-code-border px-3 py-2 font-mono text-chat-code text-chat-foreground scrollbar-sleek"
    >
      <span className="text-(--chat-link)">❯ </span>
      {command}
      {outputTruncated ? (
        <span className="block text-chat-foreground-faint">
          {t(
            'components.native-chat.composer.shellOutputTruncated',
            'Showing the last {{size}} KB of output.',
            { size: AGENT_SESSION_SHELL_COMMAND_MAX_OUTPUT_BYTES / 1024 }
          )}
        </span>
      ) : null}
      {chunks.map((chunk) => (
        <span
          key={chunk.start}
          className="block [contain-intrinsic-size:auto_500lh] [content-visibility:auto]"
        >
          <RowGroups rows={chunk.rows} start={chunk.start} />
        </span>
      ))}
      {error ? (
        <span className="block text-destructive">{error}</span>
      ) : !running && rows.length === 0 ? (
        <span className="block text-chat-foreground-faint">
          {t('components.native-chat.composer.shellNoOutput', 'No output')}
        </span>
      ) : null}
    </pre>
  )
}

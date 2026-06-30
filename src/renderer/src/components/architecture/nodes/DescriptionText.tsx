import type { ReactNode } from 'react'
import type { ArchitectureStatus } from '../architecture-diagram-types'
import { STATUS_COLORS } from './status-colors'

export type MentionNodeInfo = {
  kind: string
  status?: ArchitectureStatus
}

const REF_RE = /@\[([^\]]+)\]/g

function parseRefs(
  text: string,
  onMentionClick?: (name: string) => void,
  onMentionHover?: (name: string | null) => void,
  nodeMap?: Map<string, MentionNodeInfo>,
  resolveMap?: Map<string, string>
): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(REF_RE)) {
    if (typeof match.index === 'number' && match.index > last) {
      parts.push(text.slice(last, match.index))
    }
    const rawName = match[1]
    const displayName = resolveMap?.get(rawName) ?? rawName
    const info = nodeMap?.get(rawName)
    const statusStyle = info?.status ? STATUS_COLORS[info.status] : null
    parts.push(
      <span
        key={key++}
        className={`inline-flex items-baseline gap-0.5 rounded px-1 font-mono text-[0.85em] font-medium leading-none align-baseline ${
          statusStyle
            ? `border bg-[var(--surface-tint)] ${statusStyle.text}${onMentionClick ? ` cursor-pointer` : ''}`
            : `bg-[var(--surface-tint)] text-[var(--text-secondary)]${
                onMentionClick ? ' cursor-pointer hover:bg-[var(--surface-active)]' : ''
              }`
        }`}
        style={statusStyle ? { borderColor: statusStyle.stroke } : undefined}
        onClick={
          onMentionClick
            ? (event) => {
                event.stopPropagation()
                onMentionClick(rawName)
              }
            : undefined
        }
        onMouseEnter={onMentionHover ? () => onMentionHover(rawName) : undefined}
        onMouseLeave={onMentionHover ? () => onMentionHover(null) : undefined}
      >
        {displayName.length > 30 ? `${displayName.slice(0, 30)}...` : displayName}
      </span>
    )
    last = (match.index ?? 0) + match[0].length
  }
  if (last < text.length) {
    parts.push(text.slice(last))
  }
  return parts
}

export function DescriptionText({
  text,
  onMentionClick,
  onMentionHover,
  nodeMap,
  resolveMap
}: {
  text: string
  onMentionClick?: (name: string) => void
  onMentionHover?: (name: string | null) => void
  nodeMap?: Map<string, MentionNodeInfo>
  resolveMap?: Map<string, string>
}): React.JSX.Element {
  const lines = text.split('\n')
  const isList = lines.some((line) => /^[-*]\s/.test(line.trimStart()))

  if (!isList) {
    return (
      <span className="block break-words overflow-hidden">
        {parseRefs(text, onMentionClick, onMentionHover, nodeMap, resolveMap)}
      </span>
    )
  }

  return (
    <ul className="w-full space-y-0.5 pl-3 text-left">
      {lines.map((line, index) => {
        const trimmed = line.trimStart()
        const bullet = /^[-*]\s/.test(trimmed)
        if (!trimmed) {
          return null
        }
        return (
          <li key={`${index}-${trimmed}`} className={bullet ? 'list-disc' : 'list-none'}>
            {parseRefs(
              bullet ? trimmed.slice(2) : trimmed,
              onMentionClick,
              onMentionHover,
              nodeMap,
              resolveMap
            )}
          </li>
        )
      })}
    </ul>
  )
}

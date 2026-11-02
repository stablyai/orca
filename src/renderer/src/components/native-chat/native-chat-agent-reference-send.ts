import type { JSONContent } from '@tiptap/react'
import { imageReferenceToken } from '../../../../shared/native-chat/native-chat-image-reference'
import {
  agentReferenceToken,
  isPublicOrchestrationAddress,
  printableAgentLabel,
  type OrchestrationAgentReference
} from '../../../../shared/orchestration-agent-reference'
import {
  projectNativeChatPastedText,
  projectNativeChatPastedTextParts
} from './native-chat-composer-pasted-text-references'

type SelectedReference = {
  reference: OrchestrationAgentReference
  labels: Set<string>
  safeLabels: Set<string>
  label: string
  affected: boolean
}

function framedLabel(label: string): string {
  return printableAgentLabel(label).replace(/[\\"[\]]/g, '\\$&') || 'Agent'
}

/** Only a matching submitted document contributes targets; delivery owns the finished plain text. */
export function serializeNativeChatAgentReferences(
  text: string,
  document?: JSONContent,
  files: Readonly<Record<string, string>> = {}
): string {
  const selected = new Map<string, SelectedReference>()
  const occurrences: (SelectedReference | string)[] = []
  const render = (node: JSONContent): string => {
    if (node.type === 'nativeChatAgentReference') {
      const { label, address, hostKey } = node.attrs ?? {}
      if (typeof label !== 'string' || typeof address !== 'string' || typeof hostKey !== 'string') {
        return ''
      }
      const reference = { label, address, hostKey }
      const literal = agentReferenceToken(reference)
      if (isPublicOrchestrationAddress(address)) {
        const key = JSON.stringify([hostKey, address])
        let target = selected.get(key)
        if (!target) {
          target = {
            reference,
            labels: new Set(),
            safeLabels: new Set(),
            label: framedLabel(label),
            affected: false
          }
          selected.set(key, target)
        }
        target.labels.add(label)
        target.safeLabels.add(framedLabel(label))
        occurrences.push(target)
      } else {
        occurrences.push(literal)
      }
      return literal
    }
    if (node.type === 'hardBreak') {
      occurrences.push('\n')
      return '\n'
    }
    if (node.type === 'doc' || node.content) {
      return (node.content ?? [])
        .map((child, index) => {
          if (node.type === 'doc' && index > 0) {
            occurrences.push('\n')
          }
          return render(child)
        })
        .join(node.type === 'doc' ? '\n' : '')
    }
    const plain =
      node.type === 'nativeChatImageReference'
        ? imageReferenceToken(String(node.attrs?.attachmentId))
        : (node.text ?? (typeof node.attrs?.token === 'string' ? node.attrs.token : ''))
    occurrences.push(plain)
    return plain
  }
  if (!document || render(document) !== text || selected.size === 0) {
    return projectNativeChatPastedText(text, files)
  }
  const owners = new Map<string, Set<SelectedReference>>()
  const forbidden = new Set<string>()
  const spellings = new Set<string>()
  const reserve = (value: string) => {
    for (const match of value.matchAll(/\(([1-9][0-9]*)\)/g)) {
      forbidden.add(match[1])
    }
  }
  for (const target of selected.values()) {
    for (const label of target.labels) {
      reserve(label)
    }
    for (const label of target.safeLabels) {
      reserve(label)
      spellings.add(label)
      const keys = owners.get(label) ?? new Set()
      keys.add(target)
      owners.set(label, keys)
    }
  }
  for (const target of selected.values()) {
    target.affected =
      target.labels.size > 1 || [...target.safeLabels].some((label) => owners.get(label)!.size > 1)
  }
  const projected = projectNativeChatPastedTextParts(
    occurrences.map((part) =>
      typeof part === 'string'
        ? part
        : { opaque: part, tail: part.affected ? '' : (part.label.match(/\s+$/)?.[0] ?? '') }
    ),
    files
  )
  for (const part of projected) {
    if (typeof part === 'string') {
      reserve(part)
    }
  }
  let suffix = 0
  for (const target of selected.values()) {
    if (!target.affected) {
      continue
    }
    // At most forbidden.size + selected.size candidates: each skipped number was captured above.
    do {
      suffix++
    } while (forbidden.has(String(suffix)) || spellings.has(`${target.label} (${suffix})`))
    forbidden.add(String(suffix))
    target.label = `${target.label} (${suffix})`
    spellings.add(target.label)
  }
  const body = projected
    .map((part) => (typeof part === 'string' ? part : `@${part.opaque.label}`))
    .join('')
  return `${body}\n\n${[...selected.values()]
    .map(
      ({ reference, label }) =>
        `[Orca agent "${label}": ${reference.address} — message it with orca orchestration send --to ${reference.address}]`
    )
    .join('\n')}`
}

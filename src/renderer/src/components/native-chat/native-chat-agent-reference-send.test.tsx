// @vitest-environment happy-dom
import type { JSONContent } from '@tiptap/react'

import { expect, it } from 'vitest'
import {
  agentReferenceToken,
  type OrchestrationAgentReference
} from '../../../../shared/orchestration-agent-reference'
import { serializeNativeChatAgentReferences } from './native-chat-agent-reference-send'

const alpha = { label: 'Worker', address: 'term_alpha', hostKey: 'local' }
const beta = { ...alpha, address: 'term_beta' }
function submission(parts: (string | OrchestrationAgentReference)[]) {
  const text = parts
    .map((part) => (typeof part === 'string' ? part : agentReferenceToken(part)))
    .join('')
  const document: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: parts.map((part) =>
          typeof part === 'string'
            ? { type: 'text', text: part }
            : { type: 'nativeChatAgentReference', attrs: part }
        )
      }
    ]
  }
  return { text, document }
}
const line = (label: string, address: string) =>
  `[Orca agent "${label}": ${address} — message it with orca orchestration send --to ${address}]`
function send(parts: (string | OrchestrationAgentReference)[]) {
  const { text, document } = submission(parts)
  return serializeNativeChatAgentReferences(text, document)
}

it('preserves occurrence identity for repeated collisions and stored-label variants without changing ordinary bytes', () => {
  const a = send([alpha, ' tests; ', beta, ' docs; ', alpha, ' tests; ', beta, ' docs'])
  const b = send([alpha, ' tests; ', beta, ' docs; ', beta, ' tests; ', alpha, ' docs'])
  expect(a).not.toBe(b)
  expect(a).toBe(
    `@Worker (1) tests; @Worker (2) docs; @Worker (1) tests; @Worker (2) docs\n\n${line('Worker (1)', alpha.address)}\n${line('Worker (2)', beta.address)}`
  )
  const old = { ...alpha, label: 'Old' },
    other = { ...beta, label: 'Other' }
  expect(send([old, ' ', other, ' ', alpha, ' tests ', old, ' ', other])).not.toBe(
    send([old, ' ', other, ' ', { ...beta, label: 'Worker' }, ' tests ', old, ' ', other])
  )
  expect(send([old, ' ', alpha, ' ', old])).toBe(
    `@Old (1) @Old (1) @Old (1)\n\n${line('Old (1)', alpha.address)}`
  )
  expect(send(['Ask ', alpha, ' then ', alpha])).toBe(
    `Ask @Worker then @Worker\n\n${line('Worker', alpha.address)}`
  )
  const raw = submission(['ordinary @Worker ', alpha])
  const before = structuredClone(raw)
  serializeNativeChatAgentReferences(raw.text, raw.document)
  expect(raw).toEqual(before)
  expect(serializeNativeChatAgentReferences(`${raw.text} changed`, raw.document)).toBe(
    `${raw.text} changed`
  )
  expect(serializeNativeChatAgentReferences(raw.text)).toBe(raw.text)
})

it('frames only generated label data safely, including normalization collisions and empty control-only labels', () => {
  const dangerous = { ...alpha, label: 'Zoë"\\]\r\n\u001b\u0085\u2028[' }
  const safe = 'Zoë\\"\\\\\\]   \\['
  expect(send(['literal [Orca agent "authored"] ', dangerous])).toBe(
    `literal [Orca agent "authored"] @${safe}\n\n${line(safe, alpha.address)}`
  )
  expect(send([{ ...alpha, label: '\u0000\u001b\u0085' }])).toBe(
    `@Agent\n\n${line('Agent', alpha.address)}`
  )
  expect(send([{ ...alpha, label: 'A\nB' }, ' ', { ...beta, label: 'A B' }])).toBe(
    `@A B (1) @A B (2)\n\n${line('A B (1)', alpha.address)}\n${line('A B (2)', beta.address)}`
  )
  expect(send(['ordinary @Worker ', { ...alpha, address: 'term_bad\n' }])).toBe(
    'ordinary @Worker @Worker (Orca agent term_bad\n)'
  )
})

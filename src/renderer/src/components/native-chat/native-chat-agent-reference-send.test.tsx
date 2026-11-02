// @vitest-environment happy-dom
import type { JSONContent } from '@tiptap/react'
import type * as PastedTextProjection from './native-chat-composer-pasted-text-references'
import { expect, it, vi } from 'vitest'
import {
  agentReferenceToken,
  type OrchestrationAgentReference
} from '../../../../shared/orchestration-agent-reference'
import { serializeNativeChatAgentReferences } from './native-chat-agent-reference-send'
import { nativeChatPastedTextToken } from './native-chat-pasted-text-reference'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'

const work = vi.hoisted(() => ({ plainCharacters: 0, opaqueVisits: 0 }))
vi.mock('./native-chat-composer-pasted-text-references', async (importOriginal) => {
  const actual = await importOriginal<typeof PastedTextProjection>()
  return {
    ...actual,
    projectNativeChatPastedText: (
      ...args: Parameters<typeof actual.projectNativeChatPastedText>
    ) => {
      work.plainCharacters += args[0].length
      return actual.projectNativeChatPastedText(...args)
    },
    projectNativeChatPastedTextParts: (
      ...args: Parameters<typeof actual.projectNativeChatPastedTextParts>
    ) => {
      for (const part of args[0]) {
        if (typeof part === 'string') {
          work.plainCharacters += part.length
        } else {
          work.opaqueVisits++
        }
      }
      return actual.projectNativeChatPastedTextParts(...args)
    }
  }
})

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

it('reserves globally against real labels, authored suffixes and the completed file projection, preserving host tuple dedupe', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const token = nativeChatPastedTextToken(id)
  const path = '/tmp/Worker (3).txt'
  const raw = submission([
    alpha,
    ' ',
    beta,
    ' ',
    { ...alpha, address: 'term_real', label: 'Worker (1)' },
    ' authored (2) ',
    token,
    ' ',
    { ...alpha, hostKey: 'remote' }
  ])
  const result = serializeNativeChatAgentReferences(raw.text, raw.document, { [id]: path })
  expect(result).toContain(
    `@Worker (4) @Worker (5) @Worker (1) authored (2) ${formatNativeChatFileReference(path)} @Worker (6)`
  )
  expect(result).toContain(line('Worker (4)', alpha.address))
  expect(result).toContain(line('Worker (6)', alpha.address))
  expect(result.match(/\[Orca agent/g)).toHaveLength(4)
  const huge = '9'.repeat(400)
  expect(send([alpha, ` (${huge}) `, beta, ' (1) (01)'])).toContain('@Worker (2)')
  expect(send(['authored\0@', alpha, '\0', beta])).toContain('@Worker (1)\0@Worker (2)')
  const ordinary = submission(['before', token, alpha, 'after'])
  expect(
    serializeNativeChatAgentReferences(ordinary.text, ordinary.document, { [id]: '/tmp/plain.txt' })
  ).toBe(
    `before ${formatNativeChatFileReference('/tmp/plain.txt')} @Workerafter\n\n${line('Worker', alpha.address)}`
  )
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

it('bounds cumulative real projection work at N and 10N without multiplying authored NULs by selected occurrences', () => {
  const results = [
    { nul: 100, atoms: 10, raw: 420, units: 273, bytes: 275 },
    { nul: 1000, atoms: 100, raw: 4200, units: 1893, bytes: 1895 }
  ].map((size) => {
    const parts: (string | OrchestrationAgentReference)[] = ['\0'.repeat(size.nul)]
    for (let i = 0; i < size.atoms; i++) {
      parts.push(alpha, ' ')
    }
    const input = submission(parts)
    const before = structuredClone(input)
    Object.assign(work, { plainCharacters: 0, opaqueVisits: 0 })
    const body = serializeNativeChatAgentReferences(input.text, input.document)
    const observed = { ...size, ...work, total: work.plainCharacters + work.opaqueVisits }
    return { ...observed, body, input, before }
  })
  for (const result of results) {
    expect(result.body).toBe(
      `${'\0'.repeat(result.nul)}${'@Worker '.repeat(result.atoms)}\n\n[Orca agent "Worker": term_alpha — message it with orca orchestration send --to term_alpha]`
    )
    expect(result.body.length).toBe(result.units)
    expect(new TextEncoder().encode(result.body).length).toBe(result.bytes)
    expect(result.input.text.length).toBe(result.raw)
    expect(result.input).toEqual(result.before)
    expect(result.total).toBeLessThanOrEqual(4 * result.raw)
    expect(result.plainCharacters).toBeGreaterThan(0)
    expect(result.opaqueVisits).toBe(result.atoms)
  }
  expect(results[1].total).toBeGreaterThan(results[0].total)
})

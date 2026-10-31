// @vitest-environment happy-dom
import type { JSONContent } from '@tiptap/react'
import type * as PastedTextProjection from './native-chat-composer-pasted-text-references'
import type * as ImagePaste from '../../../../shared/agent-image-paste'
import { expect, it, vi } from 'vitest'
import {
  agentReferenceToken,
  type OrchestrationAgentReference
} from '../../../../shared/orchestration-agent-reference'
import { serializeNativeChatAgentReferences } from './native-chat-agent-reference-send'
import {
  nativeChatPastedTextToken,
  nativeChatPastedTextOperations
} from './native-chat-pasted-text-reference'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { resolveNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import {
  clearNativeChatComposerDraftsForTests,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

const work = vi.hoisted(() => ({ plainCharacters: 0, opaqueVisits: 0, pathVisits: 0 }))
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
vi.mock('../../../../shared/agent-image-paste', async (importOriginal) => {
  const actual = await importOriginal<typeof ImagePaste>()
  return {
    ...actual,
    formatNativeChatFileReference: (
      ...args: Parameters<typeof actual.formatNativeChatFileReference>
    ) => {
      work.pathVisits++
      return actual.formatNativeChatFileReference(...args)
    }
  }
})

const alpha = { label: 'Worker', address: 'term_alpha', hostKey: 'local' }
const beta = { ...alpha, address: 'term_beta' }
export function submission(parts: (string | OrchestrationAgentReference)[]) {
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
    Object.assign(work, { plainCharacters: 0, opaqueVisits: 0, pathVisits: 0 })
    const body = serializeNativeChatAgentReferences(input.text, input.document)
    const observed = { ...size, ...work, total: work.plainCharacters + work.opaqueVisits }
    process.stdout.write(
      `${JSON.stringify({ event: 'serializer-projection-work', ...observed })}\n`
    )
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

it('preserves the shared path fold, lexical boundaries and reservation boundaries around opaque atoms', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const token = nativeChatPastedTextToken(id)
  const tail = { ...alpha, label: 'Worker ' }
  const cases: {
    parts: (string | OrchestrationAgentReference)[]
    path: string
    expected: string
    paths: number
  }[] = [
    {
      parts: [token, alpha],
      path: '/tmp/plain',
      expected: `@/tmp/plain @Worker\n\n${line('Worker', 'term_alpha')}`,
      paths: 1
    },
    {
      parts: [tail, token],
      path: '/tmp/plain',
      expected: `@Worker @/tmp/plain\n\n${line('Worker ', 'term_alpha')}`,
      paths: 1
    },
    {
      parts: [tail, '', token, { ...beta, label: 'Worker ' }],
      path: '/tmp/plain',
      expected: `@Worker  (1) @/tmp/plain @Worker  (2)\n\n${line('Worker  (1)', 'term_alpha')}\n${line('Worker  (2)', 'term_beta')}`,
      paths: 1
    },
    {
      parts: [token, '', token, alpha],
      path: '/tmp/plain',
      expected: `@/tmp/plain @/tmp/plain @Worker\n\n${line('Worker', 'term_alpha')}`,
      paths: 2
    },
    {
      parts: [token.slice(0, 23), token.slice(23), alpha],
      path: '/tmp/plain',
      expected: `@/tmp/plain @Worker\n\n${line('Worker', 'term_alpha')}`,
      paths: 1
    },
    {
      parts: [token.slice(0, 23), alpha, token.slice(23)],
      path: '/tmp/plain',
      expected: `${token.slice(0, 23)}@Worker${token.slice(23)}\n\n${line('Worker', 'term_alpha')}`,
      paths: 0
    },
    {
      parts: ['(1', alpha, ') ', beta],
      path: '/tmp/plain',
      expected: `(1@Worker (1)) @Worker (2)\n\n${line('Worker (1)', 'term_alpha')}\n${line('Worker (2)', 'term_beta')}`,
      paths: 0
    },
    {
      parts: ['(1', ') ', alpha, beta],
      path: '/tmp/plain',
      expected: `(1) @Worker (2)@Worker (3)\n\n${line('Worker (2)', 'term_alpha')}\n${line('Worker (3)', 'term_beta')}`,
      paths: 0
    },
    {
      parts: [token, alpha, beta],
      path: '/tmp/Worker (1)',
      expected: `@"/tmp/Worker (1)" @Worker (2)@Worker (3)\n\n${line('Worker (2)', 'term_alpha')}\n${line('Worker (3)', 'term_beta')}`,
      paths: 1
    },
    {
      parts: [token, alpha],
      path: '/tmp/\0\0.txt',
      expected: `@/tmp/\0\0.txt @Worker\n\n${line('Worker', 'term_alpha')}`,
      paths: 1
    }
  ]
  for (const { parts, path, expected, paths } of cases) {
    const input = submission(parts)
    const files = { [id]: path }
    const before = structuredClone({ input, files })
    Object.assign(work, { plainCharacters: 0, opaqueVisits: 0, pathVisits: 0 })
    const body = serializeNativeChatAgentReferences(input.text, input.document, files)
    const observed = { ...work }
    process.stdout.write(`${JSON.stringify({ event: 'serializer-boundary-work', ...observed })}\n`)
    expect(body).toBe(expected)
    expect(observed.pathVisits).toBe(paths)
    expect(observed.opaqueVisits).toBeGreaterThan(0)
    expect({ input, files }).toEqual(before)
  }
})

it('retains document geometry and whole-literal fallback without turning unselected tokens into targets', () => {
  const document: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '🙂' },
          { type: 'hardBreak' },
          { type: 'nativeChatImageReference', attrs: { attachmentId: 'image-1' } },
          { type: 'nativeChatSkill', attrs: { token: '$review', path: '/skills/review' } },
          { type: 'nativeChatAgentReference', attrs: alpha }
        ]
      },
      { type: 'paragraph', content: [] }
    ]
  }
  const raw = `🙂\n[Image](orca-image:image-1)$review@Worker (Orca agent term_alpha)\n`
  const before = structuredClone(document)
  expect(serializeNativeChatAgentReferences(raw, document)).toBe(
    `🙂\n[Image](orca-image:image-1)$review@Worker\n\n\n${line('Worker', 'term_alpha')}`
  )
  expect(serializeNativeChatAgentReferences(`${raw}!`, document)).toBe(`${raw}!`)
  expect(serializeNativeChatAgentReferences(raw)).toBe(raw)
  expect(document).toEqual(before)
})

it('keeps live and copied plain projection semantics for completed, saving, unsaved and missing paste text', () => {
  clearNativeChatComposerDraftsForTests()
  const scope = 'serializer-plain-projection'
  const id = '11111111-1111-4111-8111-111111111111'
  const pending = '22222222-2222-4222-8222-222222222222'
  const missing = '33333333-3333-4333-8333-333333333333'
  const token = nativeChatPastedTextToken(id)
  const saving = nativeChatPastedTextToken(pending)
  const unsaved = nativeChatPastedTextToken(missing)
  updateNativeChatComposerDraft(
    scope,
    { text: token, pastedTextFiles: { [id]: '/tmp/plain' } },
    'immediate'
  )
  nativeChatPastedTextOperations.set(pending, { scopeKey: scope, text: '' })
  try {
    const raw = `${token}${saving}${token}${unsaved}tail`
    expect(resolveNativeChatPastedText(scope, raw)).toBe(
      `@/tmp/plain ${saving} @/tmp/plain ${unsaved}tail`
    )
    expect(resolveNativeChatPastedText(scope, raw, true)).toBe(
      '@/tmp/plain @/tmp/plain Paste not savedtail'
    )
    nativeChatPastedTextOperations.set(pending, { scopeKey: scope, text: 'copy source' })
    expect(resolveNativeChatPastedText(scope, `${token}${saving}${token}`, true)).toBe(
      '@/tmp/plain copy source @/tmp/plain'
    )
    nativeChatPastedTextOperations.delete(pending)
    expect(resolveNativeChatPastedText(scope, saving, true)).toBe('Paste not saved')
    expect(
      serializeNativeChatAgentReferences(`${token}${saving}`, undefined, { [id]: '/tmp/plain' })
    ).toBe(`@/tmp/plain ${saving}`)
  } finally {
    nativeChatPastedTextOperations.delete(pending)
    clearNativeChatComposerDraftsForTests()
  }
})

import type { z } from 'zod'
import { expect, expectTypeOf, it } from 'vitest'
import { projectSessionSearchResult } from './ai-vault-search-projection'
import { ReceivedSessionSearchResultSchema } from './ai-vault-search-contract'
import type { OutboundSessionSearchResultSchema } from './ai-vault-search-contract'
import type { AiVaultSearchResult, AiVaultSearchHit } from './ai-vault-search-types'

const hit: AiVaultSearchHit = {
  agent: 'codex',
  sessionId: 'same-id',
  filePath: '/same/file.jsonl',
  codexHome: null,
  title: 'title',
  cwd: '/same',
  branch: null,
  updatedAt: null,
  messageCount: 1,
  resumeCommand: 'codex resume same-id',
  score: 1,
  evidence: { role: 'user', timestamp: null, snippet: '🦀'.repeat(5000) }
}
const result = (hits: AiVaultSearchHit[]): AiVaultSearchResult => ({
  hits,
  route: 'phrase',
  durationMs: 1,
  coverage: {
    sessionsIndexed: hits.length,
    messagesIndexed: hits.length,
    providers: [],
    backfill: 'complete',
    filesPending: 0,
    lastIndexedAt: null
  }
})

it('bounds snippets on UTF-8 boundaries while preserving paths and session identity', () => {
  const projected = projectSessionSearchResult(result([hit]))
  expect(Buffer.byteLength(projected.hits[0]!.evidence.snippet)).toBe(4096)
  expect(projected.hits[0]!.evidence.snippet).not.toContain('\uFFFD')
  expect(projected.hits[0]).toMatchObject({ sessionId: hit.sessionId, filePath: hit.filePath })
  expect(projected.truncatedSnippets).toBe(1)
})

it('omits oversized identities and caps serialized response size with explicit accounting', () => {
  const projected = projectSessionSearchResult(
    result([
      { ...hit, sessionId: 'x'.repeat(40000) },
      ...Array.from({ length: 100 }, () => ({ ...hit, title: 'x'.repeat(32000) }))
    ])
  )
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(512 * 1024)
  expect(projected.omittedHits! + projected.hits.length).toBe(101)
})

it('never truncates a snippet into an unclosable mark', () => {
  const cutInsideAMark = {
    ...hit,
    evidence: { ...hit.evidence, snippet: `${'a'.repeat(4094)}[[needle]]` }
  }
  const snippet = projectSessionSearchResult(result([cutInsideAMark])).hits[0]!.evidence.snippet
  expect(snippet).not.toContain('[[')
  expect(snippet).toBe('a'.repeat(4094))
})

// A client and the host it queries update independently, so one unknown enum
// value must cost at most the hit that carries it.
it('keeps a response a newer host filled with values this build does not know', () => {
  const fromNewerHost: unknown = {
    ...result([]),
    hits: [
      { ...hit, evidence: { ...hit.evidence, role: 'planner', snippet: '' } },
      { ...hit, agent: 'agent-from-the-future', evidence: { ...hit.evidence, snippet: '' } }
    ],
    route: 'vector',
    coverage: {
      sessionsIndexed: 0,
      messagesIndexed: 0,
      providers: [],
      backfill: 'draining',
      filesPending: 0,
      lastIndexedAt: null,
      indexing: {
        phase: 'compacting',
        filesProcessed: 0,
        filesTotal: null,
        failures: 0,
        startedAt: 0
      }
    }
  }
  const parsed = ReceivedSessionSearchResultSchema.parse(fromNewerHost)
  expect(parsed.hits.map((entry) => entry.evidence.role)).toEqual(['unknown'])
  expect(parsed.route).toBe('or')
  expect(parsed.coverage.backfill).toBe('running')
  expect(parsed.coverage.indexing?.phase).toBe('indexing')
})

// Why equality and not assignability in both directions: an *optional* field on
// only one side satisfies both directions, and every field at risk here
// (`omittedHits`, `truncatedSnippets`, `duplicateCount`) is optional. A field
// only on the type is stripped before transport; a field only in the schema
// rejects a successful local search on arrival.
it('keeps the wire schema and the result type in step', () => {
  expectTypeOf<AiVaultSearchResult>().toEqualTypeOf<
    z.infer<typeof OutboundSessionSearchResultSchema>
  >()
})

// Strict on send, tolerant on receive: the same payload must fail one and pass
// the other, or a local producer bug ships as a stuck progress bar.
it('rejects a locally produced enum it would accept from another host', () => {
  const local = { ...result([hit]), route: 'vector' } as unknown as AiVaultSearchResult
  expect(() => projectSessionSearchResult(local)).toThrow()
  expect(ReceivedSessionSearchResultSchema.parse(local).route).toBe('or')
})

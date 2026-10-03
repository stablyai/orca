import { describe, expect, it } from 'vitest'
import { AiVaultSessionSearchIndex } from './ai-vault-session-index'
import { createAiVaultTestSession } from './ai-vault-session-test-session'

describe('AiVaultSessionSearchIndex', () => {
  it('indexes title and preview tokens and answers without scanning every session', () => {
    const index = new AiVaultSessionSearchIndex()
    index.upsert(
      createAiVaultTestSession({
        id: 'claude:1',
        title: 'Fix Linux pairing',
        previewMessages: [{ role: 'user', text: 'Pairing on Linux still flakes', timestamp: null }]
      })
    )
    index.upsert(
      createAiVaultTestSession({
        id: 'codex:2',
        agent: 'codex',
        title: 'Rewrite the onboarding wizard'
      })
    )

    expect([...(index.query(['pairing', 'linux']) ?? [])]).toEqual(['claude:1'])
    expect([...(index.query(['wizard']) ?? [])]).toEqual(['codex:2'])
    expect(index.query(['missing'])?.size).toBe(0)
  })

  it('updates and deletes postings incrementally', () => {
    const index = new AiVaultSessionSearchIndex()
    const first = createAiVaultTestSession({
      id: 'claude:1',
      title: 'Fix Linux pairing',
      modifiedAt: '2026-05-01T10:10:00.000Z'
    })
    index.upsert(first)
    expect(index.upsert(first)).toBe(false)

    index.upsert({
      ...first,
      title: 'Repair Windows pairing',
      modifiedAt: '2026-05-01T11:00:00.000Z'
    })
    expect([...(index.query(['windows']) ?? [])]).toEqual(['claude:1'])
    expect(index.query(['linux'])?.size).toBe(0)

    expect(index.remove('claude:1')).toBe(true)
    expect(index.size).toBe(0)
    expect(index.query(['windows'])?.size).toBe(0)
  })

  it('syncs the live session set by upserting new ids and dropping stale ones', () => {
    const index = new AiVaultSessionSearchIndex()
    index.sync([
      createAiVaultTestSession({ id: 'keep', title: 'Keep this session' }),
      createAiVaultTestSession({ id: 'drop', title: 'Drop this session' })
    ])
    index.sync([
      createAiVaultTestSession({
        id: 'keep',
        title: 'Keep this session updated',
        modifiedAt: '2026-05-02T00:00:00.000Z'
      }),
      createAiVaultTestSession({ id: 'next', title: 'Brand new session' })
    ])

    expect(index.ids().sort()).toEqual(['keep', 'next'])
    expect([...(index.query(['updated']) ?? [])]).toEqual(['keep'])
    expect(index.query(['drop'])?.size).toBe(0)
  })

  it('unions tokens in or mode for natural-language recall', () => {
    const index = new AiVaultSessionSearchIndex()
    index.sync([
      createAiVaultTestSession({ id: 'a', title: 'Linux pairing' }),
      createAiVaultTestSession({ id: 'b', title: 'Windows installer' })
    ])

    expect([...(index.query(['linux', 'installer'], 'or') ?? [])].sort()).toEqual(['a', 'b'])
  })

  it('indexes CJK title tokens so non-ASCII queries match', () => {
    const index = new AiVaultSessionSearchIndex()
    index.upsert(createAiVaultTestSession({ id: 'claude:cjk', title: '真假四人 café' }))
    expect([...(index.query(['真假四人']) ?? [])]).toEqual(['claude:cjk'])
    expect([...(index.query(['café']) ?? [])]).toEqual(['claude:cjk'])
  })

  it('treats empty and malformed timestamps as 0 so time filters stay comparable', () => {
    const index = new AiVaultSessionSearchIndex()
    index.upsert(
      createAiVaultTestSession({
        id: 'bad-dates',
        updatedAt: '',
        createdAt: 'not-a-date',
        modifiedAt: 'also-bad'
      })
    )
    const document = index.get('bad-dates')
    expect(document?.updatedAtMs).toBe(0)
    expect(document?.createdAtMs).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import type { AiVaultSession, AiVaultUserPrompt } from '../../../../shared/ai-vault-types'
import { buildPromptTimeline } from './ai-vault-prompt-timeline'

function session(id: string, prompts: AiVaultUserPrompt[]): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: id,
    title: id,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/logs/${id}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-05-02T09:00:00.000Z',
    modifiedAt: '2026-05-02T09:00:00.000Z',
    messageCount: prompts.length,
    totalTokens: 0,
    previewMessages: [],
    userPrompts: prompts,
    resumeCommand: 'claude --resume'
  }
}

// 2026-05-02T12:00 local reference "now".
const NOW = new Date('2026-05-02T12:00:00.000Z').getTime()

describe('buildPromptTimeline', () => {
  it('flattens prompts across sessions, newest-first, grouped by day', () => {
    const { groups } = buildPromptTimeline(
      [
        session('a', [
          { text: 'ayer temprano', timestamp: '2026-05-01T08:00:00.000Z' },
          { text: 'hoy tarde', timestamp: '2026-05-02T11:00:00.000Z' }
        ]),
        session('b', [{ text: 'hoy temprano', timestamp: '2026-05-02T07:00:00.000Z' }])
      ],
      '',
      NOW
    )

    expect(groups.map((g) => g.kind)).toEqual(['today', 'yesterday'])
    expect(groups[0]?.items.map((i) => i.text)).toEqual(['hoy tarde', 'hoy temprano'])
    expect(groups[1]?.items.map((i) => i.text)).toEqual(['ayer temprano'])
  })

  it('filters prompts by a case-insensitive query on the text', () => {
    const { groups } = buildPromptTimeline(
      [
        session('a', [
          { text: 'soluciona el CONFLICTO del 5595', timestamp: '2026-05-02T10:00:00.000Z' },
          { text: 'sube el PR', timestamp: '2026-05-02T10:05:00.000Z' }
        ])
      ],
      'conflicto',
      NOW
    )

    expect(groups.flatMap((g) => g.items).map((i) => i.text)).toEqual([
      'soluciona el CONFLICTO del 5595'
    ])
  })

  it('classifies days older than yesterday as "older"', () => {
    const { groups } = buildPromptTimeline(
      [session('a', [{ text: 'viejo', timestamp: '2026-04-20T10:00:00.000Z' }])],
      '',
      NOW
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind).toBe('older')
  })

  it('keeps a prompt without a timestamp using its session time as fallback', () => {
    const { groups } = buildPromptTimeline([session('a', [{ text: 'sin fecha', timestamp: null }])], '', NOW)
    expect(groups.flatMap((g) => g.items).map((i) => i.text)).toEqual(['sin fecha'])
  })

  it('ignores sessions without captured prompts', () => {
    const withoutPrompts = session('empty', [])
    delete (withoutPrompts as { userPrompts?: unknown }).userPrompts
    const { groups, total } = buildPromptTimeline([withoutPrompts], '', NOW)
    expect(groups).toEqual([])
    expect(total).toBe(0)
  })

  it('caps rendered items to maxItems (newest kept) while reporting the full total', () => {
    const prompts = Array.from({ length: 5 }, (_, index) => ({
      text: `prompt ${index}`,
      timestamp: `2026-05-02T10:0${index}:00.000Z`
    }))
    const { groups, total } = buildPromptTimeline([session('a', prompts)], '', NOW, 2)
    expect(total).toBe(5)
    expect(groups.flatMap((g) => g.items).map((i) => i.text)).toEqual(['prompt 4', 'prompt 3'])
  })
})

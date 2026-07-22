/**
 * G2 live dogfood harness: drives shipped inject + draft builders with the
 * real omp print reply captured on node-b (g2-omp-raw.txt content embedded
 * at test generation time via env or fixture).
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentDraftShapeProps,
  buildCollabCanvasInjectPayload,
  isAgentDraftShapeType
} from './collab-canvas-bridge'
import { injectCollabPayloadIntoTerminal } from './session-inject'
import { PASTE_TERMINAL_TEXT_EVENT } from '@/constants/terminal'

const FIXTURE = new URL('./fixtures/g2-omp-raw.txt', import.meta.url)
const SCRATCH = '/tmp/grok-goal-05c28523eecd/implementer'
const OMP_RAW = existsSync(`${SCRATCH}/g2-omp-raw.txt`)
  ? `${SCRATCH}/g2-omp-raw.txt`
  : fileURLToPath(FIXTURE)

describe('G2 live omp dogfood (node-b transcript)', () => {
  it('injects selection via paste event and drafts the live omp reply', () => {
    expect(existsSync(OMP_RAW)).toBe(true)
    const raw = readFileSync(OMP_RAW, 'utf8')
    const reply = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('Add a check'))
      .at(-1)
    expect(reply).toBeTruthy()
    expect(reply!.length).toBeGreaterThan(20)

    const selection = {
      boardId: 'g2-dogfood-board',
      worktreeId: 'wt-g2-dogfood',
      textDigest:
        'Operator sketched a red rectangle around the login form. Please propose a one-sentence fix for the form validation bug.',
      atlasDataUri: null,
      bounds: { x: 10, y: 20, w: 200, h: 100 },
      selectedShapeIds: ['shape:op-1']
    }

    const payload = buildCollabCanvasInjectPayload(selection)
    expect(payload.usesExistingSessionAgent).toBe(true)

    const dispatch = vi.fn()
    const result = injectCollabPayloadIntoTerminal(payload, {
      tabId: 'term-g2-dogfood',
      dispatch
    })
    expect(result).toEqual({
      ok: true,
      usesExistingSessionAgent: true,
      tabId: 'term-g2-dogfood'
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0][0] as CustomEvent
    expect(ev.type).toBe(PASTE_TERMINAL_TEXT_EVENT)
    expect(ev.detail.tabId).toBe('term-g2-dogfood')
    expect(ev.detail.text).toContain('g2-dogfood-board')
    expect(ev.detail.text).toContain('OPERATOR — collab board selection')
    expect(ev.detail.text).toContain(selection.textDigest)

    const draft = buildAgentDraftShapeProps({
      boardId: selection.boardId,
      body: reply!,
      sourceTurnId: 'omp-print-g2-dogfood',
      draftId: 'draft-g2-live-1'
    })
    expect(draft.typeName).toBe('agent-draft')
    expect(isAgentDraftShapeType(draft.typeName)).toBe(true)
    expect(draft.status).toBe('provisional')
    expect(draft.visual.strokeStyle).toBe('dashed')
    expect(draft.visual.label).toBe('Agent draft')
    expect(draft.body).toBe(reply)
  })
})

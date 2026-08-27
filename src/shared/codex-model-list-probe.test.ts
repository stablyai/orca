import { describe, expect, it, vi } from 'vitest'
import { CODEX_MODEL_LIST_MAX_JSON_CHARACTERS, parseCodexModelList } from './codex-model-list-probe'

describe('Codex model list probe', () => {
  it('rejects oversized output before JSON.parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      expect(parseCodexModelList(' '.repeat(CODEX_MODEL_LIST_MAX_JSON_CHARACTERS + 1))).toEqual([])
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })
})

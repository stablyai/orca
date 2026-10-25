import { describe, expect, it, vi } from 'vitest'

import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './terminal-bracketed-paste'
import { chunkTerminalPastePlan } from './terminal-paste-chunks'
import { planTerminalPaste } from './terminal-paste-coordinator'
import { executeTerminalPastePlan } from './terminal-paste-executor'
import type { TerminalPasteTarget } from './terminal-paste-model'

const IMAGE_PATH = '/tmp/orca-paste-1760000000000-id.png'

const target: TerminalPasteTarget = {
  kind: 'terminal',
  paneId: 1,
  leafId: 'leaf-1',
  ptyId: 'pty-1',
  runtime: { platform: 'darwin', runtimeKey: 'local:darwin', kind: 'local' }
}

describe('terminal paste draft separator', () => {
  it('writes the separator before the paste frame of a chunked paste', () => {
    const plan = planTerminalPaste({
      text: IMAGE_PATH,
      source: 'keyboard',
      target,
      forceBracketedPaste: true,
      separateFromDraft: true,
      maxDirectBytes: 8,
      maxChunkBytes: 8
    })
    const chunks = chunkTerminalPastePlan(plan)

    expect(plan.mode).toBe('chunked')
    expect(chunks.slice(0, 2)).toEqual([' ', BRACKETED_PASTE_START])
    expect(chunks.at(-1)).toBe(BRACKETED_PASTE_END)
    expect(chunks.slice(2, -1).join('')).toBe(IMAGE_PATH)
  })

  it('forwards the separator to a direct bracketed paste', async () => {
    const plan = planTerminalPaste({
      text: IMAGE_PATH,
      source: 'keyboard',
      target,
      forceBracketedPaste: true,
      separateFromDraft: true
    })
    const pasteText = vi.fn()

    await executeTerminalPastePlan(plan, { pasteText })

    expect(plan.mode).toBe('bracketed-terminal')
    expect(pasteText).toHaveBeenCalledWith(IMAGE_PATH, {
      forceBracketedPaste: true,
      separateFromDraft: true
    })
  })

  it('leaves plans without the option unchanged', () => {
    const plan = planTerminalPaste({
      text: IMAGE_PATH,
      source: 'keyboard',
      target,
      forceBracketedPaste: true,
      maxDirectBytes: 8,
      maxChunkBytes: 8
    })

    expect(plan.separateFromDraft).toBeUndefined()
    expect(chunkTerminalPastePlan(plan)[0]).toBe(BRACKETED_PASTE_START)
  })
})

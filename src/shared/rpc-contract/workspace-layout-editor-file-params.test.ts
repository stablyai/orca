import { describe, expect, it } from 'vitest'
import { LayoutApplyParams } from './workspace-layout-params'

const open = (view: unknown) => ({
  command: {
    type: 'openEditorTab',
    workspace: 'wt-1',
    tabId: 'wt-1::diff::unstaged::a.ts',
    fileId: 'wt-1::diff::unstaged::a.ts',
    contentType: 'diff',
    view
  }
})

const FILE = { filePath: '/repo/a.ts', relativePath: 'a.ts', language: 'typescript' }

describe("layout.apply's editor view", () => {
  it('takes a view with its file facts, and an open without one', () => {
    const view = { view: { mode: 'diff', diffSource: 'unstaged' }, file: FILE }
    expect(LayoutApplyParams.parse(open(view)).command).toMatchObject({ view })
    const { view: _absent, ...plain } = open(undefined).command
    expect(LayoutApplyParams.safeParse({ command: plain }).success).toBe(true)
  })

  it('refuses an unknown mode, an edit view without its conflict, or a view without a file', () => {
    for (const view of [
      { view: { mode: 'terminal' }, file: FILE },
      { view: { mode: 'edit' }, file: FILE },
      { view: { mode: 'diff' } }
    ]) {
      expect(LayoutApplyParams.safeParse(open(view)).success).toBe(false)
    }
  })
})

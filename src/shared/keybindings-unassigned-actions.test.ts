import { describe, expect, it } from 'vitest'
import {
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  keybindingMatchesAction
} from './keybindings'

describe('keybindings', () => {
  it('registers unbound Toggle Diff Viewer under Editors', () => {
    const definition = getKeybindingDefinition('editor.toggleDiffViewer')
    expect(definition).toMatchObject({
      id: 'editor.toggleDiffViewer',
      title: 'Toggle Diff Viewer',
      group: 'Editors',
      scope: 'editor'
    })
    expect(definition?.searchKeywords).toEqual(
      expect.arrayContaining(['diff', 'viewer', 'changes', 'edit', 'toggle'])
    )
    expect(getEffectiveKeybindingsForAction('editor.toggleDiffViewer', 'darwin')).toEqual([])
    expect(getEffectiveKeybindingsForAction('editor.toggleDiffViewer', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('editor.toggleDiffViewer', 'win32')).toEqual([])
    expect(
      getEffectiveKeybindingsForAction('editor.toggleDiffViewer', 'darwin', {
        'editor.toggleDiffViewer': ['Mod+Shift+D']
      })
    ).toEqual(['Mod+Shift+D'])
  })

  it('binds immediate workspace delete without claiming terminal split right', () => {
    const binding = {
      key: 'Backspace',
      code: 'Backspace',
      control: true,
      meta: false,
      alt: false,
      shift: true
    }

    expect(getEffectiveKeybindingsForAction('workspace.delete', 'darwin')).toEqual([
      'Mod+Shift+Backspace'
    ])
    expect(getEffectiveKeybindingsForAction('workspace.delete', 'linux')).toEqual([
      'Mod+Shift+Backspace'
    ])
    expect(getEffectiveKeybindingsForAction('workspace.delete', 'win32')).toEqual([
      'Mod+Shift+Backspace'
    ])
    expect(keybindingMatchesAction('workspace.delete', binding, 'linux')).toBe(true)
    expect(
      keybindingMatchesAction('workspace.delete', binding, 'linux', {
        'workspace.delete': []
      })
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'workspace.delete',
        { key: 'd', code: 'KeyD', control: false, meta: true, alt: true, shift: false },
        'darwin'
      )
    ).toBe(false)
  })
})

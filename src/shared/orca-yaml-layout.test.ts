import { describe, expect, it } from 'vitest'
import {
  LayoutConfigSchema,
  classifyPosition,
  groupAllowsContentKind,
  ruleKeyForContentKind
} from './orca-yaml-layout'

describe('LayoutConfigSchema', () => {
  it('accepts the canonical 3-group config (editor / terminal / browser)', () => {
    const result = LayoutConfigSchema.safeParse({
      groups: {
        editor: { position: 'left-top' },
        terminal: { position: 'left-bottom' },
        browser: { position: 'right' }
      },
      rules: {
        'new-editor-tab': 'editor',
        'new-terminal': 'terminal',
        'new-browser-tab': 'browser'
      }
    })
    expect(result.success).toBe(true)
  })

  it('accepts an empty layout (groups + rules optional)', () => {
    expect(LayoutConfigSchema.safeParse({}).success).toBe(true)
    expect(LayoutConfigSchema.safeParse({ groups: {} }).success).toBe(true)
  })

  it('rejects unknown position values', () => {
    const result = LayoutConfigSchema.safeParse({
      groups: { foo: { position: 'middle' } }
    })
    expect(result.success).toBe(false)
  })

  it('rejects rules pointing at undeclared groups', () => {
    const result = LayoutConfigSchema.safeParse({
      groups: { editor: { position: 'center' } },
      rules: { 'new-terminal': 'nonexistent' }
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/declared in `groups`/i)
    }
  })

  it('accepts rules referencing declared groups', () => {
    const result = LayoutConfigSchema.safeParse({
      groups: { e: { position: 'center' } },
      rules: { 'new-editor-tab': 'e' }
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-string group references', () => {
    const result = LayoutConfigSchema.safeParse({
      groups: { e: { position: 'center' } },
      rules: { 'new-editor-tab': 123 as unknown as string }
    })
    expect(result.success).toBe(false)
  })
})

describe('classifyPosition', () => {
  it('maps two-axis anchors to (h, v) buckets', () => {
    expect(classifyPosition('left-top')).toEqual({ horizontalSide: 'left', verticalSide: 'top' })
    expect(classifyPosition('right-bottom')).toEqual({
      horizontalSide: 'right',
      verticalSide: 'bottom'
    })
  })

  it('maps single-axis anchors to half-buckets', () => {
    expect(classifyPosition('left')).toEqual({ horizontalSide: 'left', verticalSide: 'center' })
    expect(classifyPosition('top')).toEqual({ horizontalSide: 'center', verticalSide: 'top' })
  })

  it('maps center to both-center', () => {
    expect(classifyPosition('center')).toEqual({
      horizontalSide: 'center',
      verticalSide: 'center'
    })
  })
})

describe('groupAllowsContentKind', () => {
  it('mixed (or undefined) accepts everything', () => {
    expect(groupAllowsContentKind(undefined, 'editor')).toBe(true)
    expect(groupAllowsContentKind(undefined, 'terminal')).toBe(true)
    expect(groupAllowsContentKind(undefined, 'browser')).toBe(true)
    expect(groupAllowsContentKind('mixed', 'editor')).toBe(true)
    expect(groupAllowsContentKind('mixed', 'terminal')).toBe(true)
  })

  it('editor-locked accepts editor / diff / conflict-review only', () => {
    expect(groupAllowsContentKind('editor', 'editor')).toBe(true)
    expect(groupAllowsContentKind('editor', 'diff')).toBe(true)
    expect(groupAllowsContentKind('editor', 'conflict-review')).toBe(true)
    expect(groupAllowsContentKind('editor', 'terminal')).toBe(false)
    expect(groupAllowsContentKind('editor', 'browser')).toBe(false)
  })

  it('terminal-locked rejects browser and editor', () => {
    expect(groupAllowsContentKind('terminal', 'terminal')).toBe(true)
    expect(groupAllowsContentKind('terminal', 'editor')).toBe(false)
    expect(groupAllowsContentKind('terminal', 'browser')).toBe(false)
  })

  it('browser-locked rejects terminal and editor', () => {
    expect(groupAllowsContentKind('browser', 'browser')).toBe(true)
    expect(groupAllowsContentKind('browser', 'terminal')).toBe(false)
    expect(groupAllowsContentKind('browser', 'editor')).toBe(false)
  })

  it('does not enforce for unknown content kinds (settings, sidekick)', () => {
    expect(groupAllowsContentKind('editor', 'settings')).toBe(true)
    expect(groupAllowsContentKind('terminal', 'tasks')).toBe(true)
  })
})

describe('LayoutConfigSchema with kind', () => {
  it('accepts groups with kind field', () => {
    const result = LayoutConfigSchema.safeParse({
      groups: {
        editor: { position: 'left-top', kind: 'editor' },
        terminal: { position: 'left-bottom', kind: 'terminal' },
        browser: { position: 'right', kind: 'browser' }
      }
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown kind values', () => {
    const result = LayoutConfigSchema.safeParse({
      groups: { e: { position: 'center', kind: 'magic' } }
    })
    expect(result.success).toBe(false)
  })

  it('mixed kind is accepted', () => {
    const result = LayoutConfigSchema.safeParse({
      groups: { e: { position: 'center', kind: 'mixed' } }
    })
    expect(result.success).toBe(true)
  })
})

describe('ruleKeyForContentKind', () => {
  it('maps editor variants to new-editor-tab', () => {
    expect(ruleKeyForContentKind('editor')).toBe('new-editor-tab')
    expect(ruleKeyForContentKind('diff')).toBe('new-editor-tab')
    expect(ruleKeyForContentKind('conflict-review')).toBe('new-editor-tab')
  })

  it('maps terminal to new-terminal', () => {
    expect(ruleKeyForContentKind('terminal')).toBe('new-terminal')
  })

  it('maps browser to new-browser-tab', () => {
    expect(ruleKeyForContentKind('browser')).toBe('new-browser-tab')
  })

  it('returns null for unknown kinds (settings, sidekick, etc.)', () => {
    expect(ruleKeyForContentKind('settings')).toBeNull()
    expect(ruleKeyForContentKind('tasks')).toBeNull()
    expect(ruleKeyForContentKind('')).toBeNull()
  })
})

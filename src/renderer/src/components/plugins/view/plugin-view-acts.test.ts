import { describe, expect, it } from 'vitest'
import type { PluginDeclarativeNode } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import type { PluginDeclarativeActTarget } from '../declarative/plugin-declarative-act-targets'
import { runPluginPanelActs } from './plugin-view-acts'

/** One mounted text control whose `change` records each value it receives, as `onChange` would. */
function panel(type: 'CodeInput' | 'Input' | 'Textarea', initial: string) {
  const props = { label: 'Field' }
  const tree: PluginDeclarativeNode = {
    type: 'Stack',
    props: {},
    children: [{ type, key: 'field', props, children: [] }]
  }
  let value = initial
  const changes: string[] = []
  const target: PluginDeclarativeActTarget = {
    value: () => value,
    readOnly: () => false,
    change: (next) => {
      if (typeof next !== 'string') {
        return false
      }
      value = next
      changes.push(next)
      return true
    }
  }
  const deps = {
    driver: { tree: () => tree, send: () => {} },
    targetOf: (drawn: unknown) => (drawn === props ? target : null),
    expansionOf: () => null,
    settle: async () => {}
  }
  return { deps, changes }
}

describe('runPluginPanelActs type', () => {
  it('types CRLF and CR line breaks into a CodeInput as LF, one change per line break', async () => {
    const { deps, changes } = panel('CodeInput', '')
    const results = await runPluginPanelActs(
      [{ type: { label: 'Field' }, text: 'a\r\nb\rc' }],
      deps
    )
    expect(results).toEqual([{ ok: true }])
    expect(changes).toEqual(['a', 'a\n', 'a\nb', 'a\nb\n', 'a\nb\nc'])
  })

  it('types onto a CodeInput value with its line breaks as LF', async () => {
    const { deps, changes } = panel('CodeInput', 'a\r\nb')
    await runPluginPanelActs([{ type: { label: 'Field' }, text: 'c' }], deps)
    expect(changes).toEqual(['a\nbc'])
  })

  it('stores a CodeInput value as LF when no characters are typed', async () => {
    const { deps, changes } = panel('CodeInput', 'a\r\nb')
    await runPluginPanelActs([{ type: { label: 'Field' }, text: '' }], deps)
    expect(changes).toEqual(['a\nb'])
  })

  it('types CRLF into an Input or Textarea unchanged', async () => {
    for (const type of ['Input', 'Textarea'] as const) {
      const { deps, changes } = panel(type, '')
      await runPluginPanelActs([{ type: { label: 'Field' }, text: 'a\r\nb' }], deps)
      expect(changes.at(-1)).toBe('a\r\nb')
    }
  })
})

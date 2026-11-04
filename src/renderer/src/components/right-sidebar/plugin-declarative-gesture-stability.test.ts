import { describe, expect, it } from 'vitest'
import type { PluginDeclarativeNode } from '../../../../shared/plugins/declarative/plugin-declarative-catalog'
import {
  createPluginDeclarativeGestureStability,
  PLUGIN_DECLARATIVE_SETTLE_MS as SETTLE
} from './plugin-declarative-gesture-stability'
import { pluginDeclarativeGestureId } from '@/components/plugins/declarative/plugin-declarative-gesture-geometry'

const link = (href: string, key: string): PluginDeclarativeNode => ({
  type: 'Link',
  key,
  props: { href },
  children: ['docs']
})
const button = (label: string, key: string, id = 'c1'): PluginDeclarativeNode => ({
  type: 'Button',
  key,
  props: { onPress: { $callback: id } },
  children: [label]
})
const stack = (...children: PluginDeclarativeNode[]): PluginDeclarativeNode => ({
  type: 'Stack',
  key: '#0',
  props: {},
  children
})

describe('declarative gesture settling', () => {
  it('lets Markdown links open only once their block sat unchanged', () => {
    const controls = createPluginDeclarativeGestureStability()
    const markdown = (content: string): PluginDeclarativeNode => ({
      type: 'Markdown',
      key: 'md',
      props: { content },
      children: []
    })
    const first = '[docs](https://example.com)'
    const id = pluginDeclarativeGestureId.markdown(first)
    controls.observe(stack(markdown(first)), 0)
    expect(controls.isSettled(id, SETTLE - 1)).toBe(false)
    expect(controls.isSettled(id, SETTLE)).toBe(true)
    // New text is a new block: its links wait again.
    const second = '[docs](https://attacker.example)'
    controls.observe(stack(markdown(second)), SETTLE)
    expect(controls.isSettled(pluginDeclarativeGestureId.markdown(second), SETTLE + 1)).toBe(false)
    expect(controls.isSettled(id, SETTLE + 1)).toBe(false)
  })

  it('grants a press only once its control sat unchanged for the settle window', () => {
    const controls = createPluginDeclarativeGestureStability()
    controls.observe(stack(button('Save', 'a')), 0)
    expect(controls.isSettled('cb:c1', SETTLE - 1)).toBe(false)
    expect(controls.isSettled('cb:c1', SETTLE)).toBe(true)
    // Re-rendering in place keeps its age.
    controls.observe(stack(button('Save', 'a')), SETTLE + 100)
    expect(controls.isSettled('cb:c1', SETTLE + 101)).toBe(true)
    expect(controls.isSettled('cb:missing', SETTLE + 101)).toBe(false)
  })

  it('restarts the window when a control moves or its label changes', () => {
    const controls = createPluginDeclarativeGestureStability()
    controls.observe(stack(button('Save', 'a')), 0)
    controls.observe(stack(button('Delete everything', 'a')), 1000)
    expect(controls.isSettled('cb:c1', 1100)).toBe(false)
    controls.observe(stack(button('Delete everything', 'b')), 2000)
    expect(controls.isSettled('cb:c1', 2100)).toBe(false)
    expect(controls.isSettled('cb:c1', 2000 + SETTLE)).toBe(true)
  })

  it('applies the same rule to Links by href', () => {
    const controls = createPluginDeclarativeGestureStability()
    controls.observe(stack(link('https://a.example', 'x')), 0)
    expect(controls.isSettled('href:https://a.example', 100)).toBe(false)
    expect(controls.isSettled('href:https://a.example', 600)).toBe(true)
    controls.observe(stack(link('https://b.example', 'y'), link('https://a.example', 'x')), 1000)
    expect(controls.isSettled('href:https://a.example', 1100)).toBe(true)
    expect(controls.isSettled('href:https://b.example', 1100)).toBe(false)
    expect(controls.isSettled('href:https://unknown.example', 1100)).toBe(false)
  })
})

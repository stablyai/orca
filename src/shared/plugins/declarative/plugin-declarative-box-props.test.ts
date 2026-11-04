import { describe, expect, it } from 'vitest'
import { parsePluginDeclarativeTree } from './plugin-declarative-tree'

const box = (props: Record<string, unknown>, children: unknown[] = []) => ({
  type: 'Box',
  props,
  children
})

function parse(raw: unknown) {
  const result = parsePluginDeclarativeTree(raw)
  if (!result.ok || !result.tree) {
    throw new Error(result.ok ? 'empty tree' : result.error)
  }
  return result
}

describe('Box props', () => {
  it('keeps every valid prop', () => {
    const props = {
      direction: 'row',
      gap: 'md',
      padding: 'sm',
      paddingX: 'lg',
      paddingY: 'none',
      margin: 'xs',
      align: 'center',
      justify: 'between',
      wrap: true,
      grow: true,
      shrink: false,
      width: '50%',
      height: 0,
      minWidth: 80.5,
      minHeight: 120,
      maxWidth: '100%',
      maxHeight: 4096,
      columns: 3,
      scroll: 'y',
      border: 'danger',
      radius: 'full',
      background: 'muted'
    }
    const result = parse(box(props))
    expect(result.warnings).toEqual([])
    expect(result.tree?.props).toEqual(props)
    expect(parse(box({ border: true, background: 'success' })).warnings).toEqual([])
  })

  it.each([
    ['background', '#ff0000'],
    ['background', 'red'],
    ['border', 'thick'],
    ['width', '50px'],
    ['width', '120%'],
    ['width', '5.5%'],
    ['width', 'calc(100% - 4px)'],
    ['height', -1],
    ['minHeight', 4097],
    ['maxWidth', Number.NaN],
    ['columns', 7],
    ['columns', 1.5],
    ['gap', 'xl'],
    ['padding', 4],
    ['radius', 'xl'],
    ['scroll', 'auto'],
    ['direction', 'row-reverse'],
    ['grow', 1]
  ])('drops %s %j with a warning', (name, value) => {
    const result = parse(box({ [name]: value, wrap: true }))
    expect(result.warnings).toEqual([`Box: ignored invalid ${name}`])
    expect(result.tree?.props).toEqual({ wrap: true })
  })

  it.each(['style', 'className', 'color', 'font'])('drops the unknown prop %s', (name) => {
    const result = parse(box({ [name]: 'x' }))
    expect(result.warnings).toEqual([`Box: ignored unknown prop "${name}"`])
    expect(result.tree?.props).toEqual({})
  })

  it('nests Boxes and any other component', () => {
    const result = parse(
      box({ direction: 'row' }, [
        box({ grow: true }, [{ type: 'Text', props: {}, children: ['left'] }]),
        box({ columns: 2 }, [{ type: 'Badge', props: { tone: 'success' }, children: ['ok'] }])
      ])
    )
    expect(result.warnings).toEqual([])
    expect(result.nodes).toBe(5)
  })

  it('may not sit inside Text', () => {
    const result = parsePluginDeclarativeTree({
      type: 'Text',
      props: {},
      children: [box({})]
    })
    expect(result.ok).toBe(false)
  })
})

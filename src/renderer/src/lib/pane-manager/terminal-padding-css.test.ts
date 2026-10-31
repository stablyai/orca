import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve('src/renderer/src/assets/terminal.css'), 'utf8')

function rule(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1]
  if (body === undefined) {
    throw new Error(`missing rule ${selector}`)
  }
  const declarations = body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')
  return new Map(
    declarations.flatMap((declaration) => {
      const [name, ...value] = declaration.split(':')
      return value.length > 0 ? [[name.trim(), value.join(':').trim()] as const] : []
    })
  )
}

// Why: resolves the subset of CSS used here (px, %, var() with fallback, calc +/-/*) to pixels.
function px(value: string, vars: Record<string, number>, percentBase: number): number {
  const expression = value
    .replace(/var\((--[\w-]+)(?:,\s*([\d.]+)px)?\)/g, (_, name: string, fallback?: string) =>
      String(vars[name] ?? Number(fallback ?? 0))
    )
    .replace(/([\d.]+)%/g, (_, percent: string) => String((Number(percent) / 100) * percentBase))
    .replace(/px/g, '')
    .replace(/^calc\((.*)\)$/, '$1')
  const terms = expression.match(/[+-]?\s*[\d.]+(?:\s*\*\s*[\d.]+)?/g) ?? []
  return terms.reduce((sum, term) => {
    const [a, b = '1'] = term.replace(/\s/g, '').split('*')
    return sum + Number(a) * Number(b)
  }, 0)
}

describe('terminal window padding css', () => {
  const pane = { width: 1000, height: 500 }
  const vars = {
    '--pane-padding-x': 100,
    '--pane-padding-y': 20,
    '--orca-pane-top-banner-height': 30
  }

  it.each(['.xterm-container', '.pane:has(> .pane-top-banner) .xterm-container'])(
    'pads %s equally on both sides',
    (selector) => {
      const base = rule('.xterm-container')
      const declarations = new Map([...base, ...rule(selector)])
      const left = px(declarations.get('margin-left') ?? '0', vars, pane.width)
      const width = px(declarations.get('width') ?? '0', vars, pane.width)
      const top = px(declarations.get('margin-top') ?? '0', vars, pane.height)
      const height = px(declarations.get('height') ?? '0', vars, pane.height)
      const banner = selector === '.xterm-container' ? 0 : vars['--orca-pane-top-banner-height']

      expect({ left, right: pane.width - left - width }).toEqual({ left: 100, right: 100 })
      expect({ top: top - banner, bottom: pane.height - top - height }).toEqual({
        top: 20,
        bottom: 20
      })
    }
  )
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SyntaxHighlighterModule from './syntax-highlighter'
import { loadNodeOniguruma } from './oniguruma-test-harness'
import {
  loadedSyntaxHighlighter,
  loadSyntaxLanguage,
  type SyntaxHighlighter,
  type SyntaxHighlightResult,
  type SyntaxToken
} from './syntax-highlighter'

const oniguruma = vi.hoisted(() => ({ fails: false, loads: 0 }))

vi.mock('./oniguruma', () => ({
  loadOniguruma: () => {
    oniguruma.loads += 1
    return oniguruma.fails
      ? Promise.reject(new Error('regex engine unavailable'))
      : loadNodeOniguruma()
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
})

async function highlighterFor(language: string): Promise<SyntaxHighlighter> {
  await expect(loadSyntaxLanguage(language)).resolves.toBe('ready')
  const highlighter = loadedSyntaxHighlighter(language)
  if (!highlighter) {
    throw new Error(`${language} did not load`)
  }
  return highlighter
}

/** A module whose regex engine has not loaded yet. */
async function freshHighlighterModule(): Promise<typeof SyntaxHighlighterModule> {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return import('./syntax-highlighter')
}

function find(result: SyntaxHighlightResult, content: string): SyntaxToken | undefined {
  return result.lines.flat().find((token) => token.content.trim() === content)
}

function colors(lines: readonly (readonly SyntaxToken[])[]): unknown {
  return lines.map((line) => line.map((token) => [token.content, token.light, token.dark]))
}

describe('highlightSyntax', () => {
  it('colors each theme on its own and leaves default text to the surface', async () => {
    const result = (await highlighterFor('ts'))('const answer = 42')

    expect(result.outcome).toBe('ok')
    expect(find(result, 'const')).toMatchObject({ light: '#0000FF', dark: '#569CD6' })
    expect(find(result, '=')).toMatchObject({ light: undefined, dark: undefined })
    expect(result.lines[0].map((token) => token.content).join('')).toBe('const answer = 42')
  })

  it('continues from a returned state exactly as one pass over the whole document', async () => {
    const python = await highlighterFor('python')
    const lines = [
      'def run(x):',
      '    s = f"""multi',
      '    line {x}',
      '    """',
      '    with open(s) as f:',
      '        return f.read()'
    ]
    const whole = python(lines.join('\n'))
    const head = python(lines.slice(0, 2).join('\n'))
    const tail = python(lines.slice(2).join('\n'), head.state)

    expect(colors([...head.lines, ...tail.lines])).toEqual(colors(whole.lines))
    // After the multi-line f-string, `with` is a keyword again.
    expect(find(whole, 'with')).toMatchObject({ dark: '#C586C0' })
  })

  it('reports formatting per theme', async () => {
    const result = (await highlighterFor('markdown'))('*emphasis* and **strong**')

    expect(find(result, '*emphasis*')).toMatchObject({ lightFontStyle: 1, darkFontStyle: 1 })
    expect(find(result, '**strong**')).toMatchObject({ lightFontStyle: 2, darkFontStyle: 2 })
  })

  it.each([
    ['one line', '<template>\n  <p :title="label">{{ format(total) }}</p>\n</template>'],
    ['several lines', '<template>\n  <p>{{\n    format(total)\n  }}</p>\n</template>']
  ])('colors Vue template expressions over %s', async (_, code) => {
    // Markdown names Vue's scope first, which is what kept these plain.
    await highlighterFor('markdown')
    const result = (await highlighterFor('vue'))(code)

    expect(find(result, 'format')).toMatchObject({ dark: '#DCDCAA' })
    expect(find(result, 'total')).toMatchObject({ dark: '#9CDCFE' })
  })

  it('leaves a line too long to color plain, along with every line after it', async () => {
    const typescript = await highlighterFor('typescript')
    const code = ['const a = 1', `const long = "${'x'.repeat(2000)}"`, 'const b = 2'].join('\n')

    const result = typescript(code)

    expect(result.outcome).toBe('degraded')
    expect(find(result, 'const')).toMatchObject({ dark: '#569CD6' })
    expect(result.lines[1]).toEqual([expect.objectContaining({ dark: undefined })])
    expect(result.lines[2]).toEqual([
      {
        content: 'const b = 2',
        offset: code.lastIndexOf('const b'),
        light: undefined,
        dark: undefined,
        lightFontStyle: 0,
        darkFontStyle: 0
      }
    ])
    expect(typescript('const c = 3', result.state)).toMatchObject({
      outcome: 'degraded',
      lines: [[expect.objectContaining({ content: 'const c = 3', dark: undefined })]]
    })
  })

  it('leaves a line that runs out of time plain instead of guessing the rest', async () => {
    const typescript = await highlighterFor('typescript')
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000))

    const result = typescript('const a = `template ${value} string`')

    expect(result.outcome).toBe('degraded')
    expect(result.lines[0]).toEqual([expect.objectContaining({ dark: undefined })])
  })

  it('does not resume from a state taken before its grammar reloaded', async () => {
    const vue = await highlighterFor('vue')
    const head = vue('<template>')
    // Vue embeds YAML lazily, so loading YAML rebuilds the Vue grammar.
    await highlighterFor('yaml')

    expect(vue('  <p>hi</p>', head.state).outcome).toBe('degraded')
    expect(vue('<template>\n  <p>hi</p>').outcome).toBe('ok')
  })
})

describe('loadSyntaxLanguage', () => {
  it('reports a language without a grammar as unsupported', async () => {
    await expect(loadSyntaxLanguage('not-a-real-language')).resolves.toBe('unsupported')
    expect(loadedSyntaxHighlighter('not-a-real-language')).toBeNull()
  })

  it('accepts aliases and any letter case', async () => {
    await expect(loadSyntaxLanguage('PS1')).resolves.toBe('ready')
    expect(loadedSyntaxHighlighter('ps1')).not.toBeNull()
  })

  it('retries a failed load after a pause', async () => {
    const { loadSyntaxLanguage, loadedSyntaxHighlighter } = await freshHighlighterModule()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    oniguruma.fails = true
    try {
      await expect(loadSyntaxLanguage('rust')).resolves.toBe('failed')
      const loads = oniguruma.loads
      now += 10
      await expect(loadSyntaxLanguage('rust')).resolves.toBe('failed')
      expect(oniguruma.loads).toBe(loads)

      oniguruma.fails = false
      now += 5000
      await expect(loadSyntaxLanguage('rust')).resolves.toBe('ready')
      expect(loadedSyntaxHighlighter('rust')).not.toBeNull()
    } finally {
      oniguruma.fails = false
    }
  })

  it('stops retrying after a few failed loads', async () => {
    const { loadSyntaxLanguage } = await freshHighlighterModule()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    oniguruma.fails = true
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(loadSyntaxLanguage('go')).resolves.toBe('failed')
        now += 5000
      }
      oniguruma.fails = false
      const loads = oniguruma.loads
      await expect(loadSyntaxLanguage('go')).resolves.toBe('failed')
      expect(oniguruma.loads).toBe(loads)
    } finally {
      oniguruma.fails = false
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  QUARTO_LANGUAGE_ID,
  quartoLanguageConfiguration,
  quartoMonarchLanguage,
  registerQuartoLanguage
} from './register-quarto'

type MonarchAction = {
  token?: string
  next?: string
  nextEmbedded?: string
  switchTo?: string
}
type MonarchRule = [string | RegExp, string | MonarchAction, string?] | { include: string }

function isRuleEntry(
  rule: MonarchRule
): rule is [string | RegExp, string | MonarchAction, string?] {
  return Array.isArray(rule)
}

const tokenizer = quartoMonarchLanguage.tokenizer as Record<string, MonarchRule[]>

// Mirrors Monaco's `Rule.resolveRegex`: a rule written as a string is compiled
// per state with `$S2` replaced by the state's own argument — for a cell state
// that is the fence that opened it.
function resolveRegex(pattern: string | RegExp, openingFence: string): RegExp {
  return typeof pattern === 'string' ? new RegExp(pattern.replace('$S2', openingFence)) : pattern
}

function matchLine(
  state: string,
  line: string,
  openingFence = ''
): { token?: string; action: MonarchAction; captured?: string; captures: string[] } | undefined {
  for (const rule of tokenizer[state]) {
    if (!isRuleEntry(rule)) {
      continue
    }
    const [pattern, action, nextStateShortcut] = rule
    const regexp = resolveRegex(pattern, openingFence)
    regexp.lastIndex = 0
    const match = regexp.exec(line)
    if (!match || match.index !== 0) {
      continue
    }
    return {
      token: typeof action === 'string' ? action : action.token,
      action: typeof action === 'object' ? action : { next: nextStateShortcut },
      captured: match[1],
      captures: match.slice(1)
    }
  }
  return undefined
}

function closesCell(
  state: 'quartoCell' | 'quartoRawCell',
  openingFence: string,
  line: string
): MonarchAction | undefined {
  const matched = matchLine(state, line, openingFence)
  return matched?.action.next === '@pop' ? matched.action : undefined
}

describe('registerQuartoLanguage', () => {
  it('registers the quarto language, tokenizer, and configuration once', () => {
    const languages: { id: string }[] = [{ id: 'markdown' }]
    const register = vi.fn((entry: { id: string }) => {
      languages.push({ id: entry.id })
    })
    const monacoMock = {
      languages: {
        register,
        setMonarchTokensProvider: vi.fn(),
        setLanguageConfiguration: vi.fn(),
        getLanguages: vi.fn(() => languages)
      }
    }

    registerQuartoLanguage(monacoMock as never)
    registerQuartoLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: QUARTO_LANGUAGE_ID,
        extensions: ['.qmd', '.rmd', '.rmarkdown']
      })
    )
    expect(monacoMock.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      QUARTO_LANGUAGE_ID,
      quartoMonarchLanguage
    )
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      QUARTO_LANGUAGE_ID,
      quartoLanguageConfiguration
    )
  })

  it('starts in the front-matter-aware entry state', () => {
    expect(quartoMonarchLanguage.start).toBe('quartoStart')
    expect(quartoMonarchLanguage.tokenizer.quartoStart).toBeDefined()
  })

  it('sends a leading --- block to the yaml tokenizer and back to markdown', () => {
    expect(matchLine('quartoStart', '---')?.action).toMatchObject({
      switchTo: '@quartoFrontMatter',
      nextEmbedded: 'yaml'
    })
    expect(matchLine('quartoFrontMatter', 'format: revealjs')?.action.switchTo).toBeUndefined()
    expect(matchLine('quartoFrontMatter', '---')?.action).toMatchObject({
      switchTo: '@root',
      nextEmbedded: '@pop'
    })
  })

  it('falls through to markdown when the document has no front matter', () => {
    expect(matchLine('quartoStart', '# Title')?.action.switchTo).toBe('@root')
  })

  it('treats a mid-document --- as markdown, not front matter', () => {
    // Why: revealjs decks use `---` as a slide separator, so only line 1 may open YAML.
    expect(matchLine('root', '---')?.action.nextEmbedded).toBeUndefined()
  })

  it('colors executable cells with the engine language', () => {
    const rCell = matchLine('root', '```{r setup, include=FALSE}')
    expect(rCell?.action).toMatchObject({ next: '@quartoCell.$1', nextEmbedded: '$2' })
    expect(rCell?.captures).toEqual(['```', 'r'])
    expect(matchLine('root', '```{python}')?.captures[1]).toBe('python')
    expect(matchLine('root', '```{=html}')?.captures[1]).toBe('html')
    expect(matchLine('root', '```{ojs}')?.action.nextEmbedded).toBe('javascript')
    expect(closesCell('quartoCell', '```', '```')).toMatchObject({
      next: '@pop',
      nextEmbedded: '@pop'
    })
  })

  it('keeps an escaped ```{{python}} cell out of the engine tokenizer', () => {
    // Why: Quarto's double-brace form shows a cell without running it, and it
    // matches no markdown fence rule — the closing fence would open a block.
    const escapedCell = matchLine('root', '```{{python}}')
    expect(escapedCell?.action).toMatchObject({ next: '@quartoRawCell.$1' })
    expect(escapedCell?.action.nextEmbedded).toBeUndefined()
    expect(closesCell('quartoRawCell', '```', '```')).toMatchObject({ next: '@pop' })
  })

  it('carries the opening fence into the cell state', () => {
    // Why: the state argument is the only place the fence length survives, and
    // the closing guard reads it back as $S2.
    expect(matchLine('root', '````{python}')?.captures).toEqual(['````', 'python'])
    expect(matchLine('root', '````{{python}}')?.captured).toBe('````')
    expect(matchLine('root', '`````{ojs}')?.captured).toBe('`````')
  })

  it('closes a cell only on a fence at least as long as the one that opened it', () => {
    // Why: markdown's codeblock/codeblockgh close on exactly three backticks, so
    // a ````-fenced cell never ended and the rest of the file rendered as code.
    expect(closesCell('quartoCell', '````', '```')).toBeUndefined()
    expect(closesCell('quartoCell', '````', '````')).toMatchObject({ next: '@pop' })
    expect(closesCell('quartoCell', '```', '`````')).toMatchObject({ next: '@pop' })
    expect(closesCell('quartoRawCell', '````', '```')).toBeUndefined()
    expect(closesCell('quartoRawCell', '````', '````')).toMatchObject({ next: '@pop' })
  })

  it('keeps cell content out of the closing rule', () => {
    // Why: a fence with trailing content is not a closing fence in Quarto.
    expect(closesCell('quartoCell', '```', '``` still open')).toBeUndefined()
    expect(matchLine('quartoCell', 'x <- 1', '```')?.token).toBe('variable.source')
    expect(matchLine('quartoRawCell', 'print(1)', '```')?.token).toBe('variable.source')
  })

  it('resolves the closing fence in the rule pattern, not a cases guard', () => {
    // Why: Monaco decides where an embedded language ends by matching this rule's
    // regex alone — `_findLeavingNestedLanguageOffset` never evaluates guards — so
    // a ``` line inside a ````-fenced cell has to miss the pattern itself. With a
    // guard the engine would stop tokenizing at the very line a long fence exists
    // to show.
    const [pattern, action] = tokenizer.quartoCell[0] as [string, MonarchAction]
    expect(typeof pattern).toBe('string')
    expect(pattern).toContain('$S2')
    expect(action).toMatchObject({ next: '@pop', nextEmbedded: '@pop' })
    expect(resolveRegex(pattern, '````').test('```')).toBe(false)
    expect(resolveRegex(pattern, '````').test('````')).toBe(true)
    expect(resolveRegex(pattern, '```').test('```')).toBe(true)
  })

  it('routes long plain fences through the fence-aware states', () => {
    // Why: ````-fenced blocks are how a Quarto document shows a ``` fence, and
    // markdown's own fence rules stop at three backticks.
    const labelled = matchLine('root', '````markdown')
    expect(labelled?.action).toMatchObject({ next: '@quartoCell.$1', nextEmbedded: '$2' })
    expect(labelled?.captures).toEqual(['````', 'markdown'])
    expect(matchLine('root', '````')?.action).toMatchObject({ next: '@quartoRawCell.$1' })
  })

  it('keeps markdown fences and headings working', () => {
    const plainFence = matchLine('root', '```python')
    expect(plainFence?.action).toMatchObject({ next: '@codeblockgh', nextEmbedded: '$1' })
    expect(plainFence?.captured).toBe('python')
    expect(matchLine('root', '## Slide title')).toBeDefined()
  })

  it('marks pandoc fenced divs', () => {
    expect(matchLine('root', '::: {.callout-note}')?.token).toBe('meta.separator')
  })
})

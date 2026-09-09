import { describe, expect, it, vi } from 'vitest'
import {
  QUARTO_LANGUAGE_ID,
  quartoLanguageConfiguration,
  quartoMonarchLanguage,
  registerQuartoLanguage
} from './register-quarto'

type MonarchCases = { cases: Record<string, string | MonarchAction> }
type MonarchAction = {
  token?: string
  next?: string
  nextEmbedded?: string
  switchTo?: string
}
type MonarchRule = [RegExp, string | MonarchAction | MonarchCases, string?] | { include: string }

function isRuleEntry(rule: MonarchRule): rule is [RegExp, string | MonarchAction, string?] {
  return Array.isArray(rule)
}

const tokenizer = quartoMonarchLanguage.tokenizer as Record<string, MonarchRule[]>

function matchLine(
  state: string,
  line: string
): { token?: string; action: MonarchAction; captured?: string; captures: string[] } | undefined {
  for (const rule of tokenizer[state]) {
    if (!isRuleEntry(rule)) {
      continue
    }
    const [regexp, action, nextStateShortcut] = rule
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

// Monarch resolves a `$1~<pattern>` guard by substituting the state's own
// arguments into the pattern and testing it anchored, so `$1~$S2`*` in state
// `quartoCell.\`\`\`` becomes /^```\`*$/. Reproducing that here keeps the
// assertions on the guard that actually ships rather than on a copy of it.
function closesCell(state: 'quartoCell' | 'quartoRawCell', openingFence: string, line: string) {
  const [regexp, action] = tokenizer[state][0] as [RegExp, MonarchCases]
  regexp.lastIndex = 0
  const match = regexp.exec(line)
  if (!match || match.index !== 0) {
    return undefined
  }
  const [guard, guardedAction] = Object.entries(action.cases)[0]
  const pattern = guard.slice(guard.indexOf('~') + 1).replace('$S2', openingFence)
  return new RegExp(`^${pattern}$`).test(match[1]) ? (guardedAction as MonarchAction) : undefined
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
    expect(matchLine('quartoCell', 'x <- 1')?.token).toBe('variable.source')
    expect(matchLine('quartoRawCell', 'print(1)')?.token).toBe('variable.source')
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

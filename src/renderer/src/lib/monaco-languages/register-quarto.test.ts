import { describe, expect, it, vi } from 'vitest'
import {
  QUARTO_LANGUAGE_ID,
  quartoLanguageConfiguration,
  quartoMonarchLanguage,
  registerQuartoLanguage
} from './register-quarto'

type MonarchAction = { token?: string; next?: string; nextEmbedded?: string; switchTo?: string }
type MonarchRule = [RegExp, string | MonarchAction, string?] | { include: string }

function isRuleEntry(rule: MonarchRule): rule is [RegExp, string | MonarchAction, string?] {
  return Array.isArray(rule)
}

function matchLine(
  state: string,
  line: string
): { token?: string; action: MonarchAction; captured?: string } | undefined {
  const tokenizer = quartoMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
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
      captured: match[1]
    }
  }
  return undefined
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
    expect(rCell?.action).toMatchObject({ next: '@codeblockgh', nextEmbedded: '$1' })
    expect(rCell?.captured).toBe('r')
    expect(matchLine('root', '```{python}')?.captured).toBe('python')
    expect(matchLine('root', '```{=html}')?.captured).toBe('html')
    expect(matchLine('root', '```{ojs}')?.action.nextEmbedded).toBe('javascript')
    expect(matchLine('codeblockgh', '```')?.action).toMatchObject({
      next: '@pop',
      nextEmbedded: '@pop'
    })
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

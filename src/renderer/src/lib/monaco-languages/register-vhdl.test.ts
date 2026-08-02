import { describe, expect, it, vi } from 'vitest'
import {
  VHDL_LANGUAGE_ID,
  registerVhdlLanguage,
  vhdlLanguageConfiguration,
  vhdlMonarchLanguage
} from './register-vhdl'

type MonarchBranch = string | { token: string; next?: string }
type MonarchAction = MonarchBranch | { cases: Record<string, MonarchBranch> }
type MonarchRule = [RegExp, MonarchAction] | [RegExp, MonarchAction, string] | { include: string }
type Token = { text: string; token: string }

const tokenizer = vhdlMonarchLanguage.tokenizer as unknown as Record<string, MonarchRule[]>
const wordLists = vhdlMonarchLanguage as unknown as Record<string, string[]>

// A miniature Monarch interpreter covering exactly the features this grammar
// uses (includes, cases, push/pop). Asserting on rule shape would not catch the
// ordering bugs that actually matter here — see the apostrophe cases below.
function rulesFor(state: string): [RegExp, MonarchAction, string?][] {
  return tokenizer[state].flatMap((rule) =>
    'include' in rule ? rulesFor(rule.include.slice(1)) : [rule]
  )
}

// Monarch splices `@name` attribute references into a rule's regex at compile
// time (this grammar uses @symbols); a raw `new RegExp` would look for the
// literal text instead.
function anchored(regex: RegExp): RegExp {
  const source = regex.source.replaceAll(/@(\w+)/g, (whole, name: string) => {
    const attribute = (vhdlMonarchLanguage as unknown as Record<string, unknown>)[name]
    return attribute instanceof RegExp ? `(?:${attribute.source})` : whole
  })
  return new RegExp(`^(?:${source})`, 'i')
}

function resolveBranch(action: MonarchAction, matched: string): MonarchBranch {
  if (typeof action !== 'object' || !('cases' in action)) {
    return action
  }
  for (const [key, branch] of Object.entries(action.cases)) {
    if (key !== '@default' && wordLists[key.slice(1)].includes(matched.toLowerCase())) {
      return branch
    }
  }
  return action.cases['@default']
}

function tokenize(source: string): Token[] {
  const stack = ['root']
  const tokens: Token[] = []

  for (const line of source.split('\n')) {
    let position = 0
    while (position < line.length) {
      const rest = line.slice(position)
      const hit = rulesFor(stack.at(-1)!)
        .map((rule) => ({ rule, match: anchored(rule[0]).exec(rest) }))
        .find(({ match }) => match !== null)
      if (!hit?.match) {
        throw new Error(`no VHDL rule matched ${JSON.stringify(rest)} in state ${stack.at(-1)}`)
      }

      const branch = resolveBranch(hit.rule[1], hit.match[0])
      const token = typeof branch === 'string' ? branch : branch.token
      const nextState = hit.rule[2] ?? (typeof branch === 'string' ? undefined : branch.next)
      const text = hit.match[0]
      if (token !== '' && token !== '@rematch') {
        tokens.push({ text, token: token === '@brackets' ? 'delimiter.parenthesis' : token })
      }

      if (nextState === '@pop') {
        stack.pop()
      } else if (nextState) {
        stack.push(nextState.slice(1))
      }
      // `@rematch` re-runs the popped state over the same input, so the cursor
      // must not advance — the state change is what guarantees progress.
      if (token === '@rematch') {
        if (!nextState) {
          throw new Error('@rematch without a state change would not terminate')
        }
        continue
      }
      if (text.length === 0) {
        throw new Error(`zero-width match in state ${stack.at(-1)} without @rematch`)
      }
      position += text.length
    }
  }

  return tokens
}

function tokenFor(source: string, text: string): string | undefined {
  return tokenize(source).find((entry) => entry.text === text)?.token
}

describe('registerVhdlLanguage', () => {
  function createMonacoMock(existingLanguageIds: string[] = []) {
    return {
      languages: {
        getLanguages: vi.fn(() => existingLanguageIds.map((id) => ({ id }))),
        register: vi.fn(),
        setLanguageConfiguration: vi.fn(),
        setMonarchTokensProvider: vi.fn()
      }
    }
  }

  it('registers vhdl with a Monarch tokenizer and the common VHDL extensions', () => {
    const monaco = createMonacoMock()

    registerVhdlLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: VHDL_LANGUAGE_ID,
        extensions: ['.vhd', '.vhdl', '.vhf', '.vhi', '.vho', '.vhs', '.vht', '.vhw']
      })
    )
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      VHDL_LANGUAGE_ID,
      vhdlLanguageConfiguration
    )
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      VHDL_LANGUAGE_ID,
      vhdlMonarchLanguage
    )
  })

  it('is idempotent when the language is already registered', () => {
    const monaco = createMonacoMock([VHDL_LANGUAGE_ID])

    registerVhdlLanguage(monaco as never)

    expect(monaco.languages.register).not.toHaveBeenCalled()
    expect(monaco.languages.setMonarchTokensProvider).not.toHaveBeenCalled()
  })

  it('does not auto-close the apostrophe, which is usually an attribute tick', () => {
    const autoClosed = vhdlLanguageConfiguration.autoClosingPairs?.map((pair) =>
      'open' in pair ? pair.open : pair
    )

    expect(autoClosed).not.toContain("'")
    expect(vhdlLanguageConfiguration.surroundingPairs).toContainEqual({ open: "'", close: "'" })
  })
})

describe('vhdl tokenizer', () => {
  it('colors reserved words regardless of case', () => {
    expect(tokenFor('ENTITY counter IS', 'ENTITY')).toBe('keyword')
    expect(tokenFor('Architecture rtl of counter is', 'Architecture')).toBe('keyword')
    expect(tokenFor('entity counter is', 'entity')).toBe('keyword')
    expect(tokenFor('entity counter is', 'counter')).toBe('identifier')
  })

  it('colors VHDL-2008 reserved words that older grammars miss', () => {
    expect(tokenFor('context work_ctx is', 'context')).toBe('keyword')
    expect(tokenFor('force q to 1', 'force')).toBe('keyword')
  })

  it('colors standard types and libraries', () => {
    expect(tokenFor('signal q : std_logic_vector(7 downto 0);', 'std_logic_vector')).toBe('type')
    expect(tokenFor('library ieee;', 'ieee')).toBe('type')
    expect(tokenFor('use ieee.numeric_std.all;', 'numeric_std')).toBe('type')
  })

  it('reads an attribute tick as an attribute, not an unterminated character literal', () => {
    expect(tokenize("if rising_edge(clk) and clk'event then")).toContainEqual({
      text: "'event",
      token: 'type'
    })
    expect(tokenFor("wait until clk'event;", 'clk')).toBe('identifier')
    expect(tokenFor("for i in q'range loop", "'range")).toBe('type')
  })

  it('reads character literals, including punctuation and the apostrophe itself', () => {
    expect(tokenFor("q <= '0';", "'0'")).toBe('string')
    expect(tokenFor("if ch = '(' then", "'('")).toBe('string')
    expect(tokenFor("c := 'a';", "'a'")).toBe('string')
    expect(tokenFor("if ch = ''' then", "'''")).toBe('string')
  })

  it('keeps matching a chain of attributes', () => {
    expect(tokenize("constant m : integer := integer'base'high;").slice(-4)).toEqual([
      { text: 'integer', token: 'type' },
      { text: "'base", token: 'type' },
      { text: "'high", token: 'type' },
      { text: ';', token: 'delimiter' }
    ])
  })

  it('separates a qualified expression from the character literal it contains', () => {
    // The hard case: `'(` is the qualifying tick, but `'1'` two characters later
    // is a literal. Getting this backwards colors the rest of the line wrong.
    expect(tokenize("q <= bit'('1');")).toEqual([
      { text: 'q', token: 'identifier' },
      { text: '<=', token: 'delimiter' },
      { text: 'bit', token: 'type' },
      { text: "'", token: 'delimiter' },
      { text: '(', token: 'delimiter.parenthesis' },
      { text: "'1'", token: 'string' },
      { text: ')', token: 'delimiter.parenthesis' },
      { text: ';', token: 'delimiter' }
    ])
    expect(tokenize("q <= std_logic_vector'(others => '0');")).toContainEqual({
      text: "'0'",
      token: 'string'
    })
    expect(tokenFor("q(0) <= a(i)'delayed;", "'delayed")).toBe('type')
  })

  it('reads bit-string literals in every base and the VHDL-2008 sized forms', () => {
    expect(tokenFor('q <= x"FF";', 'x"FF"')).toBe('number.hex')
    expect(tokenFor('q <= X"00ff";', 'X"00ff"')).toBe('number.hex')
    expect(tokenFor('q <= b"1010_1010";', 'b"1010_1010"')).toBe('number.binary')
    expect(tokenFor('q <= o"777";', 'o"777"')).toBe('number.octal')
    expect(tokenFor('q <= 8x"FF";', '8x"FF"')).toBe('number.hex')
    expect(tokenFor('q <= 10sb"1010";', '10sb"1010"')).toBe('number.binary')
    expect(tokenFor('q <= d"255";', 'd"255"')).toBe('number')
  })

  it('reads std_logic meta-values inside bit-string literals', () => {
    // Everyday RTL: a tri-state or don't-care constant is still one literal, not
    // a stray identifier followed by a string.
    expect(tokenFor('q <= x"ZZZZ";', 'x"ZZZZ"')).toBe('number.hex')
    expect(tokenFor('q <= b"UU10";', 'b"UU10"')).toBe('number.binary')
    expect(tokenFor('q <= x"----";', 'x"----"')).toBe('number.hex')
  })

  it('does not let a bit-string literal span a separator', () => {
    // IEEE 1076-2008 15.3: no separator inside a lexical element.
    expect(tokenFor('q <= 8 x"FF";', '8 x"FF"')).toBeUndefined()
    expect(tokenFor('q <= 8 x"FF";', '8')).toBe('number')
  })

  it('reads based, underscored and exponent numeric literals', () => {
    expect(tokenFor('constant c : integer := 16#FFEE#;', '16#FFEE#')).toBe('number.hex')
    expect(tokenFor('constant c : integer := 2#1010_1010#;', '2#1010_1010#')).toBe('number.hex')
    expect(tokenFor('constant c : integer := 1_000;', '1_000')).toBe('number')
    expect(tokenFor('constant c : real := 1.5e-3;', '1.5e-3')).toBe('number.float')
  })

  it('reads both comment forms', () => {
    expect(tokenFor('q <= a; -- drive the output', '-- drive the output')).toBe('comment')
    expect(tokenize('/* VHDL-2008\nblock comment */ q <= a;').slice(0, 3)).toEqual([
      { text: '/*', token: 'comment' },
      { text: ' VHDL-2008', token: 'comment' },
      { text: 'block comment ', token: 'comment' }
    ])
  })

  it('does not mistake a subtraction for a comment, or a comment for an operator', () => {
    expect(tokenFor('q <= a - b;', '-')).toBe('delimiter')
    expect(tokenFor('q <=-- tight', '-- tight')).toBe('comment')
  })

  it('escapes an embedded quote by doubling it', () => {
    expect(tokenize('report "say ""hi"" now";')).toContainEqual({
      text: '""',
      token: 'string.escape'
    })
  })

  it('flags an unterminated string instead of bleeding into the next line', () => {
    const tokens = tokenize('report "oops\nq <= a;')

    expect(tokens[1]).toEqual({ text: '"oops', token: 'string.invalid' })
    expect(tokens).toContainEqual({ text: 'q', token: 'identifier' })
  })

  it('reads assignment, association and VHDL-2008 matching operators as one token each', () => {
    // Why 'delimiter' and not 'operator': neither stock Monaco theme defines an
    // `operator` rule, so the only choice that themes at all is delimiter.
    expect(tokenFor('q <= a;', '<=')).toBe('delimiter')
    expect(tokenFor('v := a;', ':=')).toBe('delimiter')
    expect(tokenFor('port map (clk => clk);', '=>')).toBe('delimiter')
    expect(tokenFor('if a ?= b then', '?=')).toBe('delimiter')
    expect(tokenFor('q <= a ** 2;', '**')).toBe('delimiter')
  })

  it('reads word operators as keywords and extended identifiers as names', () => {
    expect(tokenFor('q <= a nand b;', 'nand')).toBe('keyword')
    expect(tokenFor('q <= a sll 2;', 'sll')).toBe('keyword')
    expect(tokenFor('signal \\my signal\\ : std_logic;', '\\my signal\\')).toBe('identifier')
  })
})

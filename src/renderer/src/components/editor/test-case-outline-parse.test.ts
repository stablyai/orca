import { describe, expect, it } from 'vitest'
import { parseTestCaseOutline } from './test-case-outline-parse'

describe('parseTestCaseOutline', () => {
  it('builds nested describe/it trees with 1-based lines', () => {
    const content = [
      'describe("login", () => {',
      '  it("rejects empty password", () => {});',
      '  it("locks after 3 attempts", () => {});',
      '});',
      'describe("signup", () => {',
      '  test("sends email", () => {});',
      '});'
    ].join('\n')
    const tree = parseTestCaseOutline(content)
    expect(tree).toHaveLength(2)
    expect(tree[0].kind).toBe('describe')
    expect(tree[0].line).toBe(1)
    expect(tree[0].children.map((c) => c.title)).toEqual([
      'rejects empty password',
      'locks after 3 attempts'
    ])
    expect(tree[0].children[0].line).toBe(2)
    expect(tree[1].children[0].kind).toBe('it')
  })

  it('captures skip/only/each/todo modifiers', () => {
    const content = [
      'describe.skip("slow", () => {',
      "  it.only('fast', () => {});",
      '  test.each([[1]])("case %i", () => {});',
      '  it.todo("later");',
      '});'
    ].join('\n')
    const tree = parseTestCaseOutline(content)
    expect(tree[0].modifier).toBe('skip')
    expect(tree[0].children.map((c) => c.modifier)).toEqual(['only', 'each', 'todo'])
  })

  it('ignores matches inside comments and normalizes CRLF', () => {
    const content =
      '// it("ghost", () => {});\r\ndescribe("real", () => {\r\n  /* test("hidden") */\r\n  it("shown", () => {});\r\n});'
    const tree = parseTestCaseOutline(content)
    expect(tree).toHaveLength(1)
    expect(tree[0].title).toBe('real')
    expect(tree[0].children.map((c) => c.title)).toEqual(['shown'])
  })

  it('returns empty for files without tests', () => {
    expect(parseTestCaseOutline('const x = 1;\n')).toEqual([])
    expect(parseTestCaseOutline('')).toEqual([])
  })

  it('parses calls spanning multiple lines', () => {
    const content = [
      'describe(',
      "  'multiline suite',",
      '  () => {',
      '    it(',
      "      'multiline test',",
      '      () => {}',
      '    );',
      '    test.each([',
      '      [1, 2]',
      '    ])(',
      "      'case %i',",
      '      () => {}',
      '    );',
      '  }',
      ');'
    ].join('\n')
    const tree = parseTestCaseOutline(content)
    expect(tree).toHaveLength(1)
    expect(tree[0].title).toBe('multiline suite')
    expect(tree[0].line).toBe(1)
    expect(tree[0].children).toHaveLength(2)
    expect(tree[0].children[0].title).toBe('multiline test')
    expect(tree[0].children[0].line).toBe(4)
    expect(tree[0].children[1].title).toBe('case %i')
    expect(tree[0].children[1].line).toBe(8)
    expect(tree[0].children[1].modifier).toBe('each')
  })

  it('does not treat comment markers inside string literals as comments', () => {
    const content = [
      'describe("suite with /* comment */ in title", () => {',
      '  it("accepts /* literally", () => {});',
      "  it('accepts // literally too', () => {});",
      '  it(`accepts /* in template`, () => {});',
      '});'
    ].join('\n')
    const tree = parseTestCaseOutline(content)
    expect(tree).toHaveLength(1)
    expect(tree[0].title).toBe('suite with /* comment */ in title')
    expect(tree[0].children.map((c) => c.title)).toEqual([
      'accepts /* literally',
      'accepts // literally too',
      'accepts /* in template'
    ])
  })

  it('parses tagged-template .each suites and tests without mis-parenting', () => {
    const content = [
      'describe.each`',
      '  a    | b    | expected',
      '  ${1} | ${1} | ${2}',
      "`('$a + $b', ({ a, b, expected }) => {",
      "  it('adds numbers', () => {});",
      '});',
      'test.each`',
      '  val',
      "  ${'hello'}",
      "`('tagged test case $val', () => {});"
    ].join('\n')
    const tree = parseTestCaseOutline(content)
    expect(tree).toHaveLength(2)
    expect(tree[0].title).toBe('$a + $b')
    expect(tree[0].modifier).toBe('each')
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].title).toBe('adds numbers')
    expect(tree[1].title).toBe('tagged test case $val')
    expect(tree[1].modifier).toBe('each')
  })

  it('captures concurrent modifier on suites and tests', () => {
    const content = [
      'describe.concurrent("concurrent suite", () => {',
      '  it.concurrent("concurrent it", () => {});',
      '  test.concurrent("concurrent test", () => {});',
      '});'
    ].join('\n')
    const tree = parseTestCaseOutline(content)
    expect(tree).toHaveLength(1)
    expect(tree[0].modifier).toBe('concurrent')
    expect(tree[0].children.map((c) => c.modifier)).toEqual(['concurrent', 'concurrent'])
  })

  it('does not drift line numbers when non-string titles span lines', () => {
    const content = [
      'test(',
      '  dynamicTitle,',
      '  () => {}',
      ');',
      'it("valid test", () => {});'
    ].join('\n')
    const tree = parseTestCaseOutline(content)
    expect(tree).toHaveLength(1)
    expect(tree[0].title).toBe('valid test')
    expect(tree[0].line).toBe(5)
  })

  it('does not mis-parent children when an options object contains a brace in a literal', () => {
    const content = [
      "describe('suite', { message: '}' }, () => {",
      "  it('child test', () => {});",
      '});'
    ].join('\n')
    const tree = parseTestCaseOutline(content)
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].title).toBe('child test')
  })
})

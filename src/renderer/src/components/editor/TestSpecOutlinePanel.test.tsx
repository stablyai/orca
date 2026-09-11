import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TestSpecOutlinePanel } from './TestSpecOutlinePanel'
import { parseTestCaseOutline } from './test-case-outline-parse'

const sampleItems = parseTestCaseOutline(
  [
    'describe("login", () => {',
    '  it("rejects empty password", () => {});',
    '  it.skip("legacy", () => {});',
    '});'
  ].join('\n')
)

describe('TestSpecOutlinePanel', () => {
  it('renders the describe/it tree with modifiers and empty state', () => {
    const html = renderToStaticMarkup(
      <TestSpecOutlinePanel items={sampleItems} onClose={() => {}} onNavigate={() => {}} />
    )

    expect(html).toContain('Test Outline')
    expect(html).toContain('login')
    expect(html).toContain('rejects empty password')
    expect(html).toContain('skip')
    expect(html).toContain('Collapse login')
  })

  it('renders visible badges for all modifiers', () => {
    const items = parseTestCaseOutline(
      [
        'describe.each([[1]])("suite %i", () => {',
        '  it.only("fast", () => {});',
        '  it.todo("later");',
        '  test.concurrent("parallel", () => {});',
        '});'
      ].join('\n')
    )
    const html = renderToStaticMarkup(
      <TestSpecOutlinePanel items={items} onClose={() => {}} onNavigate={() => {}} />
    )
    expect(html).toContain('each')
    expect(html).toContain('only')
    expect(html).toContain('todo')
    expect(html).toContain('concurrent')
  })

  it('indents nested suites progressively by depth', () => {
    const items = parseTestCaseOutline(
      [
        'describe("root", () => {',
        '  describe("nested", () => {',
        '    it("leaf", () => {});',
        '  });',
        '});'
      ].join('\n')
    )
    const html = renderToStaticMarkup(
      <TestSpecOutlinePanel items={items} onClose={() => {}} onNavigate={() => {}} />
    )
    // Why: root suite has 12px padding; nested suite at depth 1 has 24px padding (12 + 1 * 12).
    expect(html).toContain('padding-left:12px')
    expect(html).toContain('padding-left:24px')
    expect(html).toContain('padding-left:36px')
  })

  it('renders an empty state with no items', () => {
    const html = renderToStaticMarkup(
      <TestSpecOutlinePanel items={[]} onClose={() => {}} onNavigate={() => {}} />
    )

    expect(html).toContain('No test cases found')
  })
})

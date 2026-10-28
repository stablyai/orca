// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Why: the real engine is a multi-megabyte TeaVM bundle needing wasm; stub it and
// drive the two shapes that matter — a diagram, and the error card it draws for
// bad input (which arrives through onSuccess, not onError).
const NAG =
  '<text>PlantUML version $version$ / $git.commit.id$ [Unknown compile time]</text>' +
  '<text>This version of PlantUML is 210 days old, so you should</text>'
const ERROR_CARD =
  `<svg>${NAG}<text>[From textarea (line 2) ]</text>` +
  '<text> Syntax Error? (Assumed diagram type: sequence)</text></svg>'
const GOOD_SVG = '<svg><text>Alice</text></svg>'

vi.mock('@plantuml/core/viz-global.js', () => ({
  default: { instance: () => Promise.resolve({}) }
}))
vi.mock('@plantuml/core', () => ({
  render: vi.fn(),
  renderToString: (lines: string[], onSuccess: (svg: string) => void) => {
    onSuccess(lines.join('\n').includes('BROKEN') ? ERROR_CARD : GOOD_SVG)
  }
}))

const { default: PlantUmlBlock } = await import('./PlantUmlBlock')

const BROKEN_SOURCE = '@startuml\nBROKEN\n@enduml'
const VALID_SOURCE = '@startuml\nAlice -> Bob\n@enduml'

// Why scope every query to the render container instead of `document`: this suite
// runs without Vitest globals, so Testing Library never registers its afterEach
// cleanup and each test's DOM outlives it.
function settled(container: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (container.querySelector('.plantuml-error, .plantuml-block *')) {
        resolve()
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

describe('PlantUmlBlock', () => {
  it('shows our own banner instead of the upstream error picture', async () => {
    const { container } = render(<PlantUmlBlock content={BROKEN_SOURCE} isDark={false} />)
    await settled(container)

    const banner = container.querySelector('.plantuml-error')?.textContent ?? ''
    expect(banner).toContain('Syntax Error?')
    expect(banner).toContain('line 2')
    expect(banner).not.toMatch(/days old|\$version\$|textarea/i)
    // The raw source stays visible so the user can fix it.
    expect(container.querySelector('.plantuml-block pre code')?.textContent).toContain('BROKEN')
  })

  it('recovers once the source is fixed', async () => {
    const { container, rerender } = render(<PlantUmlBlock content={BROKEN_SOURCE} isDark={false} />)
    await settled(container)
    expect(container.querySelector('.plantuml-error')).toBeTruthy()

    rerender(<PlantUmlBlock content={VALID_SOURCE} isDark={false} />)
    // Why assert on diagram *text* rather than the <svg> element: happy-dom's
    // DOMPurify strips the outer <svg> wrapper (a real browser keeps it), so the
    // element is absent here for reasons unrelated to this component.
    await new Promise((r) => setTimeout(r, 100))

    expect(container.querySelector('.plantuml-block')?.textContent).toContain('Alice')
    expect(container.querySelector('.plantuml-error')).toBeNull()
    // The raw-source fallback is gone too — we are showing a diagram, not a listing.
    expect(container.querySelector('.plantuml-block pre code')).toBeNull()
  })
})

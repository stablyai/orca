import { describe, expect, it } from 'vitest'
import { detectPlantUmlErrorDiagram } from './plantuml-error-diagram'

// Why: the engine reports bad input by *succeeding* with an error picture rather
// than rejecting, so these fixtures reproduce the exact marker text observed from
// @plantuml/core 1.2026.6 output. Trimmed to the structure the detector keys on.
const NAG =
  '<text fill="#33FF02" font-style="italic">PlantUML version $version$ / $git.commit.id$ [Unknown compile time]</text>' +
  '<text fill="#33FF02">This version of PlantUML is 210 days old, so you should</text>' +
  '<text fill="#33FF02">consider upgrading from https://plantuml.com/download</text>'

const syntaxErrorSvg =
  `<svg viewBox="0 0 419 190">${NAG}` +
  '<text>[From textarea (line 2) ]</text>' +
  '<text>@startuml</text>' +
  '<text>this is not valid ==== nonsense &gt;&gt;&gt;&lt;&lt;&lt;</text>' +
  '<text> Syntax Error? (Assumed diagram type: sequence)</text></svg>'

const emptyDiagramSvg =
  `<svg viewBox="0 0 419 190">${NAG}` +
  '<text>[From textarea (line 2) ]</text>' +
  '<text>@startuml</text><text>@enduml</text>' +
  '<text> Empty description (Assumed diagram type: sequence)</text></svg>'

const badKeywordSvg =
  `<svg viewBox="0 0 419 250">${NAG}` +
  '<text>[From textarea (line 5) ]</text>' +
  '<text>class A {</text>' +
  '<text> Syntax Error? (Assumed diagram type: class)</text></svg>'

const unsupportedSvg =
  '<svg viewBox="0 0 401 227">' +
  '<text fill="#000000">Diagram not supported by this release of PlantUML</text>' +
  '<text>Sorry, but the following directive </text>' +
  '<text>just some text</text>' +
  '<text> is not recognized.</text>' +
  '<text>Possible causes:</text>' +
  '<text>- Typo in the directive or incorrect syntax.</text></svg>'

const validSvg =
  '<svg viewBox="0 0 129 188"><g><rect/><text>Alice</text><text>Bob</text><text>Hello</text></g></svg>'

describe('detectPlantUmlErrorDiagram', () => {
  it('returns null for a real diagram', () => {
    expect(detectPlantUmlErrorDiagram(validSvg)).toBeNull()
  })

  it('reports the syntax error with its source line', () => {
    expect(detectPlantUmlErrorDiagram(syntaxErrorSvg)).toEqual({
      message: 'Syntax Error? (Assumed diagram type: sequence)',
      line: 2
    })
  })

  it('reports an empty diagram', () => {
    expect(detectPlantUmlErrorDiagram(emptyDiagramSvg)).toEqual({
      message: 'Empty description (Assumed diagram type: sequence)',
      line: 2
    })
  })

  it('carries the line number through for non-sequence diagrams', () => {
    expect(detectPlantUmlErrorDiagram(badKeywordSvg)).toEqual({
      message: 'Syntax Error? (Assumed diagram type: class)',
      line: 5
    })
  })

  it('reports unsupported diagrams, which carry no version banner', () => {
    expect(detectPlantUmlErrorDiagram(unsupportedSvg)).toEqual({
      message: 'Diagram not supported by this release of PlantUML'
    })
  })

  it('never leaks the upstream upgrade nag, version placeholder, or "textarea"', () => {
    for (const svg of [syntaxErrorSvg, emptyDiagramSvg, badKeywordSvg, unsupportedSvg]) {
      const detected = detectPlantUmlErrorDiagram(svg)
      expect(detected).not.toBeNull()
      expect(detected?.message).not.toMatch(
        /days old|plantuml\.com\/download|\$version\$|textarea/i
      )
    }
  })

  it('does not misfire on a diagram whose own labels mention a syntax error', () => {
    const svg = '<svg><text>Syntax Error? (Assumed diagram type: sequence)</text></svg>'
    expect(detectPlantUmlErrorDiagram(svg)).toBeNull()
  })
})

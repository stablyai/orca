import { describe, expect, it } from 'vitest'
import { detectPlantUmlErrorDiagram } from './plantuml-error-diagram'

// Why: the engine reports bad input by *succeeding* with an error picture rather
// than rejecting, so these fixtures reproduce the marker text and node ordering
// observed from @plantuml/core 1.2026.6 output. Both cards open with their banner
// as the first text node; real diagrams open with diagram content.
const NAG =
  '<text fill="#33FF02" font-style="italic">PlantUML version $version$ / $git.commit.id$ [Unknown compile time]</text>' +
  '<text fill="#33FF02">This version of PlantUML is 210 days old, so you should</text>' +
  '<text fill="#33FF02">consider upgrading from https://plantuml.com/download</text>'

const syntaxErrorSvg =
  `<svg viewBox="0 0 419 190"><defs/><g>${NAG}` +
  '<text>[From textarea (line 2) ]</text>' +
  '<text>@startuml</text>' +
  '<text>this is not valid ==== nonsense &gt;&gt;&gt;&lt;&lt;&lt;</text>' +
  '<text> Syntax Error? (Assumed diagram type: sequence)</text></g></svg>'

const emptyDiagramSvg =
  `<svg viewBox="0 0 419 190"><defs/><g>${NAG}` +
  '<text>[From textarea (line 2) ]</text>' +
  '<text>@startuml</text><text>@enduml</text>' +
  '<text> Empty description (Assumed diagram type: sequence)</text></g></svg>'

const badKeywordSvg =
  `<svg viewBox="0 0 419 250"><defs/><g>${NAG}` +
  '<text>[From textarea (line 5) ]</text>' +
  '<text>class A {</text>' +
  '<text> Syntax Error? (Assumed diagram type: class)</text></g></svg>'

const unsupportedSvg =
  '<svg viewBox="0 0 401 227"><defs/><g>' +
  '<text fill="#000000">Diagram not supported by this release of PlantUML</text>' +
  '<text>Sorry, but the following directive </text>' +
  '<text>just some text</text>' +
  '<text> is not recognized.</text>' +
  '<text>Possible causes:</text></g></svg>'

const validSvg =
  '<svg viewBox="0 0 129 188"><defs/><g><rect/><text>Alice</text><text>Bob</text><text>Hello</text></g></svg>'

describe('detectPlantUmlErrorDiagram', () => {
  it('returns null for a real diagram', () => {
    expect(detectPlantUmlErrorDiagram(validSvg)).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(detectPlantUmlErrorDiagram('<svg><defs/></svg>')).toBeNull()
  })

  it('reports the engine diagnosis verbatim, with its source line', () => {
    expect(detectPlantUmlErrorDiagram(syntaxErrorSvg)).toEqual({
      kind: 'diagnosis',
      detail: 'Syntax Error? (Assumed diagram type: sequence)',
      line: 2
    })
  })

  it('reports an empty diagram', () => {
    expect(detectPlantUmlErrorDiagram(emptyDiagramSvg)).toEqual({
      kind: 'diagnosis',
      detail: 'Empty description (Assumed diagram type: sequence)',
      line: 2
    })
  })

  it('carries the line number through for non-sequence diagrams', () => {
    expect(detectPlantUmlErrorDiagram(badKeywordSvg)).toEqual({
      kind: 'diagnosis',
      detail: 'Syntax Error? (Assumed diagram type: class)',
      line: 5
    })
  })

  it('reports unsupported diagrams, which carry no version banner', () => {
    expect(detectPlantUmlErrorDiagram(unsupportedSvg)).toEqual({ kind: 'unsupported' })
  })

  it('falls back to an unknown kind when the card carries no diagnosis', () => {
    const svg = `<svg><defs/><g>${NAG}<text>[From textarea (line 3) ]</text></g></svg>`
    expect(detectPlantUmlErrorDiagram(svg)).toEqual({ kind: 'unknown', line: 3 })
  })

  it('never returns the upstream upgrade nag or version placeholder as detail', () => {
    for (const svg of [syntaxErrorSvg, emptyDiagramSvg, badKeywordSvg, unsupportedSvg]) {
      const detected = detectPlantUmlErrorDiagram(svg)
      expect(detected).not.toBeNull()
      expect(detected?.detail ?? '').not.toMatch(
        /days old|plantuml\.com\/download|\$version\$|textarea/i
      )
    }
  })

  describe('does not misfire on diagrams that quote the card text in a label', () => {
    it('when a label mentions a syntax error', () => {
      const svg =
        '<svg><defs/><g><text>Alice</text>' +
        '<text>Syntax Error? (Assumed diagram type: sequence)</text></g></svg>'
      expect(detectPlantUmlErrorDiagram(svg)).toBeNull()
    })

    it('when a label starts with the version banner', () => {
      const svg =
        '<svg><defs/><g><text>Alice</text>' +
        '<text>PlantUML version $version$ is fine</text></g></svg>'
      expect(detectPlantUmlErrorDiagram(svg)).toBeNull()
    })

    it('when a label starts with the unsupported banner', () => {
      const svg =
        '<svg><defs/><g><text>Alice</text>' +
        '<text>Diagram not supported by this release of PlantUML</text></g></svg>'
      expect(detectPlantUmlErrorDiagram(svg)).toBeNull()
    })
  })
})

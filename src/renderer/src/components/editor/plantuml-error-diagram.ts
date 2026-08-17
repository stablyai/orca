export type PlantUmlErrorKind =
  /** The engine has no renderer for this input at all. */
  | 'unsupported'
  /** The engine named a specific problem, carried in `detail`. */
  | 'diagnosis'
  /** An error card we recognize but could not read a diagnosis out of. */
  | 'unknown'

export type PlantUmlErrorDiagram = {
  kind: PlantUmlErrorKind
  /**
   * Verbatim engine text, English only — the engine does not localize its
   * diagnoses. Callers show it as-is rather than translating it.
   */
  detail?: string
  line?: number
}

// Why: @plantuml/core signals bad input by *succeeding* with a picture of the
// error instead of calling onError, so the only way to tell a failure from a real
// diagram is to recognize the two error cards it draws.
const UNSUPPORTED_BANNER = 'Diagram not supported by this release of PlantUML'
const VERSION_BANNER = 'PlantUML version $version$'

// The engine labels the offending line "[From textarea (line N) ]" — an artifact of
// its own demo page that means nothing here, so we keep only the number.
const SOURCE_LINE = /\[From textarea \(line (\d+)\)/
const DIAGNOSIS = /\(Assumed diagram type:[^)]*\)/

function textNodes(svg: string): string[] {
  return [...svg.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean)
}

/**
 * Recognizes the error cards @plantuml/core draws in place of a diagram. Returns
 * null for real diagrams.
 *
 * Deliberately drops the upstream "your version is N days old, upgrade from
 * plantuml.com" nag and the unreplaced `$version$` placeholder; neither belongs in
 * a markdown preview.
 */
export function detectPlantUmlErrorDiagram(svg: string): PlantUmlErrorDiagram | null {
  const nodes = textNodes(svg)
  // Why match only the first text node: both cards open with their banner, while a
  // real diagram opens with its own content. Searching every node would misread a
  // diagram that quotes either banner in a label. Requiring extra card markers
  // instead would risk the opposite and worse failure — an unrecognized card
  // wording leaking the upstream nag into the preview.
  const banner = nodes[0]
  if (banner === undefined) {
    return null
  }

  if (banner.startsWith(UNSUPPORTED_BANNER)) {
    return { kind: 'unsupported' }
  }
  if (!banner.startsWith(VERSION_BANNER)) {
    return null
  }

  const detail = nodes.find((n) => DIAGNOSIS.test(n))
  const lineMatch = svg.match(SOURCE_LINE)
  const line = lineMatch ? Number(lineMatch[1]) : undefined

  return {
    ...(detail === undefined
      ? { kind: 'unknown' as const }
      : { kind: 'diagnosis' as const, detail }),
    ...(line === undefined ? {} : { line })
  }
}

export type PlantUmlErrorDiagram = {
  message: string
  line?: number
}

// Why: @plantuml/core signals bad input by *succeeding* with a picture of the
// error instead of calling onError, so the only way to tell a failure from a real
// diagram is to recognize the two error cards it draws. Both carry a fixed banner
// no legitimate diagram would render.
const VERSION_BANNER = 'PlantUML version $version$'
const UNSUPPORTED_BANNER = 'Diagram not supported by this release of PlantUML'

// The engine labels the offending line "[From textarea (line N) ]" — an artifact of
// its own demo page that means nothing here, so we keep only the number.
const SOURCE_LINE = /\[From textarea \(line (\d+)\)/
const DIAGNOSIS = /\(Assumed diagram type:[^)]*\)/

function textNodes(svg: string): string[] {
  return [...svg.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean)
}

/**
 * Recognizes the error cards @plantuml/core draws in place of a diagram and
 * extracts a message fit to show the user. Returns null for real diagrams.
 *
 * Deliberately drops the upstream "your version is N days old, upgrade from
 * plantuml.com" nag and the unreplaced `$version$` placeholder — neither belongs
 * in a markdown preview.
 */
export function detectPlantUmlErrorDiagram(svg: string): PlantUmlErrorDiagram | null {
  const nodes = textNodes(svg)

  if (nodes.some((n) => n.startsWith(UNSUPPORTED_BANNER))) {
    return { message: UNSUPPORTED_BANNER }
  }

  // Why: gate on the banner rather than the diagnosis text alone, so a diagram
  // that merely *labels a box* "Syntax Error?" still renders normally.
  if (!nodes.some((n) => n.startsWith(VERSION_BANNER))) {
    return null
  }

  const diagnosis = nodes.find((n) => DIAGNOSIS.test(n))
  const lineMatch = svg.match(SOURCE_LINE)
  const line = lineMatch ? Number(lineMatch[1]) : undefined

  return {
    message: diagnosis ?? 'PlantUML could not render this diagram',
    ...(line === undefined ? {} : { line })
  }
}

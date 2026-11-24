import { parse as parseYaml } from 'yaml'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const FRONTMATTER_ELK = /^\s*layout\s*:\s*['"]?elk(?:\.[a-z]+)?['"]?\s*$/im
const INIT_ELK =
  /%%\{\s*init\s*:\s*\{[\s\S]*?["']?layout["']?\s*:\s*["']?([a-z]+(?:\.[a-z]+)?)["']?[\s\S]*?\}\s*\}%%/i
const FLOWCHART_ELK = /^\s*flowchart-elk\b/im
const ELK_LAYOUT = /^elk(?:\.[a-z]+)?$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Mermaid reads `layout` from frontmatter's `config` map, including comments and flow maps. */
function frontmatterUsesElk(frontmatter: string): boolean {
  try {
    const parsed: unknown = parseYaml(frontmatter)
    if (!isRecord(parsed) || !isRecord(parsed.config)) {
      return false
    }
    return typeof parsed.config.layout === 'string' && ELK_LAYOUT.test(parsed.config.layout)
  } catch {
    return FRONTMATTER_ELK.test(frontmatter)
  }
}

export function sourceUsesElkLayout(content: string): boolean {
  const trimmed = content.trimStart()
  const frontmatter = FRONTMATTER.exec(trimmed)
  if (frontmatter?.[1] && frontmatterUsesElk(frontmatter[1])) {
    return true
  }
  const body = frontmatter ? trimmed.slice(frontmatter[0].length) : trimmed
  const init = INIT_ELK.exec(body)
  return (init !== null && ELK_LAYOUT.test(init[1])) || FLOWCHART_ELK.test(body)
}

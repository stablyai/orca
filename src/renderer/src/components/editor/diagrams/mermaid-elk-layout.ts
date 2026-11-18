import { parse as parseYaml } from 'yaml'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const FRONTMATTER_ELK = /^\s*layout\s*:\s*['"]?elk(?:\.[a-z]+)?['"]?\s*$/im
const INIT_ELK =
  /%%\{\s*init\s*:\s*\{[\s\S]*?["']?layout["']?\s*:\s*["']?elk(?:\.[a-z]+)?["']?[\s\S]*?\}\s*\}%%/i
const FLOWCHART_ELK = /^\s*flowchart-elk\b/im
const ELK_LAYOUT = /^elk(?:\.[a-z]+)?$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Mermaid accepts `layout` at the top level or under `config`, including YAML comments and flow maps. */
function frontmatterUsesElk(frontmatter: string): boolean {
  try {
    const parsed: unknown = parseYaml(frontmatter)
    if (!isRecord(parsed)) {
      return false
    }
    const layout = (isRecord(parsed.config) ? parsed.config.layout : undefined) ?? parsed.layout
    return typeof layout === 'string' && ELK_LAYOUT.test(layout)
  } catch {
    return FRONTMATTER_ELK.test(frontmatter)
  }
}

export function sourceUsesElkLayout(content: string): boolean {
  const frontmatter = FRONTMATTER.exec(content.trimStart())
  if (frontmatter?.[1] && frontmatterUsesElk(frontmatter[1])) {
    return true
  }
  return INIT_ELK.test(content) || FLOWCHART_ELK.test(content)
}

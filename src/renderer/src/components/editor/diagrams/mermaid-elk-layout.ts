const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const FRONTMATTER_ELK = /^\s*layout\s*:\s*['"]?elk(?:\.[a-z]+)?['"]?\s*$/im
const INIT_ELK =
  /%%\{\s*init\s*:\s*\{[\s\S]*?["']?layout["']?\s*:\s*["']?elk(?:\.[a-z]+)?["']?[\s\S]*?\}\s*\}%%/i
const FLOWCHART_ELK = /^\s*flowchart-elk\b/im

export function sourceUsesElkLayout(content: string): boolean {
  const frontmatter = FRONTMATTER.exec(content.trimStart())
  if (frontmatter?.[1] && FRONTMATTER_ELK.test(frontmatter[1])) {
    return true
  }
  return INIT_ELK.test(content) || FLOWCHART_ELK.test(content)
}

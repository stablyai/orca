import { useCallback, useRef, useState } from 'react'
import { joinPath } from '@/lib/path'
import { extractFrontMatter } from '@/components/editor/markdown-frontmatter'
import type {
  ClaudeConfig,
  AgentItem,
  SkillItem,
  CommandItem,
  RuleItem,
  McpServerItem
} from './claude-config-types'
import { EMPTY_CONFIG } from './claude-config-types'

type McpConfig = {
  mcpServers?: Record<
    string,
    {
      type?: string
      url?: string
      command?: string
      description?: string
    }
  >
}

// Why: only handles flat key:value lines — not a full YAML parser. Quoted values
// and block scalars (|, >) are not supported; the `---` delimiters from
// extractFrontMatter's raw output are harmlessly skipped (no colon).
function parseSimpleYaml(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      continue
    }
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) {
      result[key] = value
    }
  }
  return result
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Reads all .md files from a directory in parallel, extracts frontmatter,
 * and maps each to a typed item via the provided transform function.
 */
async function scanMarkdownDir<T>(
  dirPath: string,
  worktreePath: string,
  mapItem: (name: string, yaml: Record<string, string>, filePath: string, relativePath: string) => T
): Promise<T[]> {
  const entries = await window.api.fs.readDir({ dirPath }).catch(() => null)
  if (!entries) {
    return []
  }

  const mdEntries = entries.filter((e) => !e.isDirectory && e.name.endsWith('.md'))
  const results = await Promise.all(
    mdEntries.map(async (entry) => {
      const filePath = joinPath(dirPath, entry.name)
      const result = await window.api.fs.readFile({ filePath }).catch(() => null)
      if (!result) {
        return null
      }
      const fm = extractFrontMatter(result.content)
      const yaml = fm ? parseSimpleYaml(fm.raw) : {}
      const relativePath = filePath.slice(worktreePath.length + 1)
      return mapItem(entry.name.replace(/\.md$/, ''), yaml, filePath, relativePath)
    })
  )
  return results.filter((item): item is NonNullable<typeof item> => item !== null) as T[]
}

export function useClaudeConfig(worktreePath: string | null) {
  const [config, setConfig] = useState<ClaudeConfig>(EMPTY_CONFIG)
  const [loading, setLoading] = useState(false)
  const [hasClaudeDir, setHasClaudeDir] = useState(false)
  const scanIdRef = useRef(0)

  const scan = useCallback(async () => {
    if (!worktreePath) {
      setConfig(EMPTY_CONFIG)
      setHasClaudeDir(false)
      return
    }

    const scanId = ++scanIdRef.current
    setLoading(true)

    try {
      const claudeDir = joinPath(worktreePath, '.claude')
      const dirEntries = await window.api.fs.readDir({ dirPath: claudeDir }).catch(() => null)

      if (!dirEntries) {
        setConfig(EMPTY_CONFIG)
        setHasClaudeDir(false)
        return
      }

      setHasClaudeDir(true)

      if (scanIdRef.current !== scanId) {
        return
      }

      const [agents, skills, commands, rules, mcpServers] = await Promise.all([
        scanAgents(worktreePath, claudeDir),
        scanSkills(worktreePath, claudeDir, dirEntries),
        scanCommands(worktreePath, claudeDir),
        scanRules(worktreePath, claudeDir, dirEntries),
        scanMcpServers(worktreePath)
      ])

      if (scanIdRef.current !== scanId) {
        return
      }

      setConfig({
        agents: sortByName(agents),
        skills: sortByName(skills),
        commands: sortByName(commands),
        rules: sortByName(rules),
        mcpServers: sortByName(mcpServers)
      })
    } catch (err) {
      console.warn('Failed to scan Claude config:', err)
    } finally {
      if (scanIdRef.current === scanId) {
        setLoading(false)
      }
    }
  }, [worktreePath])

  return { config, loading, hasClaudeDir, scan }
}

async function scanAgents(worktreePath: string, claudeDir: string): Promise<AgentItem[]> {
  return scanMarkdownDir(
    joinPath(claudeDir, 'agents'),
    worktreePath,
    (name, yaml, filePath, relativePath) => ({
      name,
      description: yaml.description ?? '',
      filePath,
      relativePath,
      model: yaml.model,
      tools: yaml.tools
    })
  )
}

async function scanSkills(
  worktreePath: string,
  claudeDir: string,
  dirEntries: { name: string; isDirectory: boolean }[]
): Promise<SkillItem[]> {
  // Why: skills use a subdirectory-per-skill layout (each contains SKILL.md),
  // unlike agents/commands/rules which are flat .md files in a single directory.
  const hasSkillsDir = dirEntries.some((e) => e.name === 'skills' && e.isDirectory)
  if (!hasSkillsDir) {
    return []
  }

  const skillsDir = joinPath(claudeDir, 'skills')
  const skillDirs = await window.api.fs.readDir({ dirPath: skillsDir }).catch(() => null)
  if (!skillDirs) {
    return []
  }

  const dirOnly = skillDirs.filter((e) => e.isDirectory)
  const results = await Promise.all(
    dirOnly.map(async (entry) => {
      const skillDir = joinPath(skillsDir, entry.name)
      const skillMdPath = joinPath(skillDir, 'SKILL.md')
      const result = await window.api.fs.readFile({ filePath: skillMdPath }).catch(() => null)
      if (!result) {
        return null
      }
      const fm = extractFrontMatter(result.content)
      const yaml = fm ? parseSimpleYaml(fm.raw) : {}
      return {
        name: yaml.name ?? entry.name,
        description: yaml.description ?? '',
        filePath: skillMdPath,
        relativePath: skillMdPath.slice(worktreePath.length + 1)
      }
    })
  )
  return results.filter((item): item is SkillItem => item !== null)
}

async function scanCommands(worktreePath: string, claudeDir: string): Promise<CommandItem[]> {
  return scanMarkdownDir(
    joinPath(claudeDir, 'commands'),
    worktreePath,
    (name, yaml, filePath, relativePath) => ({
      name: yaml.name ?? name,
      description: yaml.description ?? '',
      filePath,
      relativePath
    })
  )
}

async function scanRules(
  worktreePath: string,
  claudeDir: string,
  dirEntries: { name: string; isDirectory: boolean }[]
): Promise<RuleItem[]> {
  const hasRulesDir = dirEntries.some((e) => e.name === 'rules' && e.isDirectory)
  if (!hasRulesDir) {
    return []
  }

  return scanMarkdownDir(
    joinPath(claudeDir, 'rules'),
    worktreePath,
    (name, yaml, filePath, relativePath) => {
      const pathsRaw = yaml.paths
      const paths = pathsRaw
        ? pathsRaw
            .split(',')
            .map((p: string) => p.trim())
            .filter(Boolean)
        : undefined
      return {
        name,
        description: yaml.description ?? '',
        filePath,
        relativePath,
        paths
      }
    }
  )
}

async function scanMcpServers(worktreePath: string): Promise<McpServerItem[]> {
  const mcpPath = joinPath(worktreePath, '.mcp.json')
  const result = await window.api.fs.readFile({ filePath: mcpPath }).catch(() => null)
  if (!result) {
    return []
  }

  let config: McpConfig
  try {
    config = JSON.parse(result.content) as McpConfig
  } catch {
    return []
  }

  const servers = config.mcpServers
  if (!servers) {
    return []
  }

  const items: McpServerItem[] = []
  for (const [name, server] of Object.entries(servers)) {
    const isHttp = server.type === 'http' || !!server.url
    items.push({
      name,
      description: server.description ?? '',
      filePath: mcpPath,
      relativePath: '.mcp.json',
      type: isHttp ? 'http' : 'stdio',
      url: server.url,
      command: server.command
    })
  }
  return items
}

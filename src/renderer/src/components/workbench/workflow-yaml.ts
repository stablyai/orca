import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  WorkflowCliShell,
  WorkflowNodeDef,
  WorkflowNodeKind,
  WorkflowPreset
} from './workflow-presets'

type RawYamlStep = {
  id?: unknown
  name?: unknown
  kind?: unknown
  shell?: unknown
  agent?: unknown
  model?: unknown
  prompt?: unknown
  run?: unknown
  description?: unknown
}

type RawYamlWorkflow = {
  name?: unknown
  description?: unknown
  steps?: unknown
}

function normalizeShell(raw: unknown): WorkflowCliShell | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const shell = raw.trim()
  switch (shell) {
    case 'auto':
    case 'powershell':
    case 'pwsh':
    case 'cmd':
    case 'bash':
    case 'sh':
    case 'wsl':
      return shell
    default:
      return undefined
  }
}

function normalizeKind(raw: unknown): WorkflowNodeKind {
  if (typeof raw !== 'string') {
    return 'implement'
  }
  switch (raw) {
    case 'analyze':
    case 'implement':
    case 'verify':
    case 'accept':
    case 'commit':
    case 'cli':
      return raw
    default:
      return 'implement'
  }
}

export function parseWorkflowYaml(
  content: string,
  fileName: string,
  filePath: string
): WorkflowPreset | null {
  try {
    const doc: RawYamlWorkflow | null = parseYaml(content)
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.steps)) {
      return null
    }
    const nodes: WorkflowNodeDef[] = doc.steps
      .filter((s): s is RawYamlStep => Boolean(s) && typeof s === 'object')
      .map((step, index) => {
        const label =
          typeof step.name === 'string' && step.name.trim() ? step.name.trim() : `Step ${index + 1}`
        const id =
          typeof step.id === 'string' && step.id.trim() ? step.id.trim() : `step-${index + 1}`
        const kind = normalizeKind(step.kind ?? (step.run ? 'cli' : 'implement'))
        const instruction =
          typeof step.run === 'string' && step.run.trim()
            ? step.run.trim()
            : typeof step.prompt === 'string' && step.prompt.trim()
              ? step.prompt.trim()
              : undefined
        const desc =
          typeof step.description === 'string' && step.description.trim()
            ? step.description.trim()
            : (instruction ?? label)
        const shell = normalizeShell(step.shell)
        const agent =
          typeof step.agent === 'string' && step.agent.trim() ? step.agent.trim() : undefined
        const model =
          typeof step.model === 'string' && step.model.trim() ? step.model.trim() : undefined
        return {
          id,
          kind,
          defaultLabel: label,
          defaultDescription: desc,
          instruction,
          shell,
          agent,
          model
        }
      })

    if (nodes.length === 0) {
      return null
    }

    const baseName = fileName.replace(/\.(ya?ml)$/i, '')
    return {
      id: `yaml:${fileName}`,
      custom: true,
      filePath,
      defaultName: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : baseName,
      defaultDescription:
        typeof doc.description === 'string' && doc.description.trim()
          ? doc.description.trim()
          : nodes.map((n) => n.defaultLabel).join(' → '),
      nodes
    }
  } catch {
    return null
  }
}

export async function loadRepoYamlWorkflows(
  rootPath: string,
  connectionId?: string
): Promise<WorkflowPreset[]> {
  const workflowsDir = `${rootPath.replace(/[\\/]+$/, '')}/.orca/workflows`
  try {
    const entries = await window.api.fs.readDir({ dirPath: workflowsDir, connectionId })
    const yamlFiles = entries.filter(
      (entry) => !entry.isDirectory && /\.(ya?ml)$/i.test(entry.name)
    )
    const results = await Promise.all(
      yamlFiles.map(async (entry) => {
        const filePath = `${workflowsDir}/${entry.name}`
        try {
          const file = await window.api.fs.readFile({ filePath, connectionId })
          if (file.isBinary) {
            return null
          }
          return parseWorkflowYaml(file.content, entry.name, filePath)
        } catch {
          return null
        }
      })
    )
    return results.filter((item): item is WorkflowPreset => item !== null)
  } catch {
    return []
  }
}

export function serializeWorkflowYaml(
  name: string,
  description: string,
  nodes: readonly WorkflowNodeDef[]
): string {
  const doc = {
    name,
    description,
    steps: nodes.map((n) => ({
      id: n.id,
      name: n.defaultLabel,
      kind: n.kind,
      ...(n.shell && n.shell !== 'auto' ? { shell: n.shell } : {}),
      ...(n.agent ? { agent: n.agent } : {}),
      ...(n.model ? { model: n.model } : {}),
      ...(n.kind === 'verify' || n.kind === 'cli'
        ? n.instruction
          ? { run: n.instruction }
          : {}
        : n.instruction
          ? { prompt: n.instruction }
          : {})
    }))
  }
  return stringifyYaml(doc)
}

export function buildSampleWorkflowYaml(name: string): string {
  return `# Orca Workflow YAML 配置 (存放于 .orca/workflows/*.yml)
# kind 可选值: analyze | implement | verify | accept | commit | cli
# - AI 节点使用 prompt，可选指定 agent / model
# - cli / verify 节点可使用 run 执行本地命令（不调用大模型）
name: ${name}
description: Analyze requirement, implement changes, verify checks, and accept
steps:
  - id: analyze
    name: Analyze
    kind: analyze
    prompt: Break down the requirement and locate target files
  - id: implement
    name: Implement
    kind: implement
    prompt: Implement changes cleanly in the isolated worktree
  - id: verify
    name: Verify
    kind: verify
    run: pnpm tc
  - id: accept
    name: Accept
    kind: accept
    prompt: Review diff and confirm acceptance
`
}

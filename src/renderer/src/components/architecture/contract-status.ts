import type {
  ArchitectureContractItem,
  ArchitectureDiagramModel,
  ArchitectureDiagramNode
} from './architecture-diagram-types'

export type NormalizedContractItem = {
  text: string
  passed?: boolean
  url?: string
  image?: {
    filename: string
    mimeType: string
    data: string
  }
}

export function contractItemText(item: ArchitectureContractItem): string {
  return typeof item === 'string' ? item : item.text
}

export function normalizeContractItem(item: ArchitectureContractItem): NormalizedContractItem {
  return typeof item === 'string' ? { text: item } : { ...item }
}

export function setContractItemPassed(
  item: ArchitectureContractItem,
  passed: boolean | undefined
): ArchitectureContractItem {
  const normalized = normalizeContractItem(item)
  return passed === undefined
    ? {
        ...normalized,
        passed: undefined
      }
    : {
        ...normalized,
        passed
      }
}

export function collectInheritedExpectItems(
  model: ArchitectureDiagramModel,
  nodeId: string
): NormalizedContractItem[] {
  const byId = new Map(model.nodes.map((node) => [node.id, node]))
  const chain: ArchitectureDiagramNode[] = []
  let current = byId.get(nodeId)
  while (current) {
    chain.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return chain.flatMap((node) =>
    (node.data.contract?.expect ?? []).map((item) => normalizeContractItem(item))
  )
}

export function getVerifiedBlockers(model: ArchitectureDiagramModel, nodeId: string): string[] {
  return collectInheritedExpectItems(model, nodeId)
    .filter((item) => item.passed !== true)
    .map((item) => item.text)
}

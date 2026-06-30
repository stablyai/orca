import type { ArchitectureViewDto } from '../../../../shared/scryer/architecture-view'
import type {
  ArchitectureDiagramKind,
  ArchitectureDiagramLink,
  ArchitectureDiagramModel,
  ArchitectureDiagramNode,
  ArchitectureDiagramShape
} from './architecture-diagram-types'

const KNOWN_SHAPES = new Set<ArchitectureDiagramShape>([
  'rectangle',
  'person',
  'cylinder',
  'pipe',
  'trapezoid',
  'bucket',
  'hexagon'
])

function diagramKind(node: ArchitectureViewDto['nodes'][number]): ArchitectureDiagramKind {
  if (node.kind !== 'symbol') {
    return node.kind
  }
  const symbolKind = node.appearance?.symbolKind
  return symbolKind === 'operation' || symbolKind === 'process' || symbolKind === 'model'
    ? symbolKind
    : 'operation'
}

function nodeType(kind: ArchitectureDiagramKind): ArchitectureDiagramNode['type'] {
  return kind === 'operation' || kind === 'process' || kind === 'model' ? kind : 'architecture'
}

function shapeFromAppearance(
  appearance: Record<string, unknown> | undefined
): ArchitectureDiagramShape | undefined {
  const shape = appearance?.shape
  return typeof shape === 'string' && KNOWN_SHAPES.has(shape as ArchitectureDiagramShape)
    ? (shape as ArchitectureDiagramShape)
    : undefined
}

export function architectureViewToDiagramModel(
  view: ArchitectureViewDto,
  projectPath: string
): ArchitectureDiagramModel {
  return {
    projectPath,
    nodes: view.nodes.map((node): ArchitectureDiagramNode => {
      const kind = diagramKind(node)
      const shape = shapeFromAppearance(node.appearance)
      return {
        id: node.id,
        type: nodeType(kind),
        parentId: node.parentId,
        position: { x: 0, y: 0 },
        data: {
          name: node.name,
          description: node.description ?? '',
          kind,
          ...(node.technology !== undefined ? { technology: node.technology } : {}),
          ...(node.external !== undefined ? { external: node.external } : {}),
          ...(shape ? { shape } : {}),
          ...(node.properties
            ? {
                properties: node.properties.map((property) => ({
                  label: property.label,
                  description: property.description ?? ''
                }))
              }
            : {}),
          ...(node.notes ? { notes: [node.notes] } : {}),
          _needsLayout: true
        }
      }
    }),
    links: view.links.map(
      (link): ArchitectureDiagramLink => ({
        id: link.id,
        source: link.src,
        target: link.dst,
        data: {
          label: link.label,
          ...(link.method !== undefined ? { method: link.method } : {})
        }
      })
    ),
    groups: view.groups.map((group) => ({
      id: group.id,
      name: group.name,
      memberIds: group.memberIds,
      ...(group.description !== undefined ? { description: group.description } : {}),
      ...(group.parentGroupId !== undefined ? { parentGroupId: group.parentGroupId } : {}),
      ...(group.parentNodeId !== undefined ? { parentNodeId: group.parentNodeId } : {})
    })),
    sourceMap: view.sourceMap,
    boundaries: view.boundaries,
    validationWarnings: view.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'warning')
      .map((diagnostic) => ({
        kind: 'missing-mention',
        path: diagnostic.path ?? '',
        reference: diagnostic.code,
        message: diagnostic.message
      })),
    refPositions: {}
  }
}

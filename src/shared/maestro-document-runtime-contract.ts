import type { z } from 'zod'
import {
  MaestroDocumentAuthoringMutationSchema,
  MaestroDocumentLayoutMutationSchema,
  type MaestroDocument,
  type MaestroDocumentAuthoringMutation,
  type MaestroDocumentEdge
} from './maestro-document-contract'

export type MaestroDocumentNodeInput = {
  position?: { x: number; y: number }
  kind?: 'layout' | 'note'
  title?: string
  markdown?: string
  note_revision?: number
  context_snapshot_id?: string
}
export type MaestroDocumentInput = {
  nodes: Record<string, MaestroDocumentNodeInput>
  edges?: readonly MaestroDocumentEdge[]
  viewport?: { center: { x: number; y: number }; zoom: number }
}
export type MaestroDocumentReadResult =
  | { state: 'empty'; revision: null; document: null; updatedAt: null }
  | { state: 'ready'; revision: number; document: MaestroDocument; updatedAt: string }
export type MaestroDocumentLayoutMutation = z.infer<typeof MaestroDocumentLayoutMutationSchema>

export function parseMaestroDocumentLayoutMutation(value: unknown): MaestroDocumentLayoutMutation {
  return MaestroDocumentLayoutMutationSchema.parse(value)
}

export function parseMaestroDocumentAuthoringMutation(
  value: unknown
): MaestroDocumentAuthoringMutation {
  return MaestroDocumentAuthoringMutationSchema.parse(value)
}

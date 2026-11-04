import { create } from 'zustand'
import type {
  WorkflowNode,
  WorkflowPreset
} from '../../../../shared/workflow/workflow-definition-schema'
import type { WorkflowValidationIssue } from '../../../../shared/workflow/workflow-validation'
import type { WorkflowClipboard } from './workflow-editor-mutations'

export type WorkflowSelection =
  | { kind: 'nodes'; ids: string[] }
  | { kind: 'dependency'; id: string }
  | { kind: 'communication'; id: string }
  | null

export type WorkflowEdgeLayer = 'all' | 'execution' | 'communication'

type Snapshot = Pick<
  WorkflowPreset,
  'definition' | 'layout' | 'name' | 'description' | 'defaultRunSettings'
>

const HISTORY_LIMIT = 100

/**
 * Keep the previous object for every node a commit left unchanged, so a card's node selector
 * returns the same reference and only edited nodes re-render. Drafts are always cloned before
 * mutation, so sharing never aliases a mutable object.
 */
function shareUnchangedNodes(
  previous: readonly WorkflowNode[],
  next: WorkflowNode[]
): WorkflowNode[] {
  const byId = new Map(previous.map((node) => [node.id, node]))
  return next.map((node) => {
    const prior = byId.get(node.id)
    return prior && JSON.stringify(prior) === JSON.stringify(node) ? prior : node
  })
}

/** Panning and zooming are view state: saved with the preset, but never unsaved work. */
function workflowDraftFingerprint(preset: WorkflowPreset): string {
  return JSON.stringify({ ...preset, layout: { ...preset.layout, viewport: null } })
}

type WorkflowEditorState = {
  preset: WorkflowPreset | null
  /** Serialized preset as last saved; the draft is dirty whenever it differs. */
  savedJson: string | null
  selection: WorkflowSelection
  past: Snapshot[]
  future: Snapshot[]
  clipboard: { data: WorkflowClipboard; definition: WorkflowPreset['definition'] } | null
  issues: WorkflowValidationIssue[]
  mode: 'design' | 'execution'
  layer: WorkflowEdgeLayer
  load: (preset: WorkflowPreset, options: { saved: boolean }) => void
  markSaved: (preset: WorkflowPreset) => void
  /** Apply a mutation to a copy of the draft; history records it unless told otherwise. */
  commit: (mutate: (draft: WorkflowPreset) => void, options?: { history?: boolean }) => void
  /** Record the state before a gesture (a drag) that commits without history while it runs. */
  checkpoint: () => void
  select: (selection: WorkflowSelection) => void
  undo: () => void
  redo: () => void
  setClipboard: (clipboard: WorkflowEditorState['clipboard']) => void
  setIssues: (issues: WorkflowValidationIssue[]) => void
  setMode: (mode: WorkflowEditorState['mode']) => void
  setLayer: (layer: WorkflowEdgeLayer) => void
}

function snapshot(preset: WorkflowPreset): Snapshot {
  return structuredClone({
    definition: preset.definition,
    layout: preset.layout,
    name: preset.name,
    description: preset.description,
    defaultRunSettings: preset.defaultRunSettings
  })
}

export const useWorkflowEditorStore = create<WorkflowEditorState>((set, get) => ({
  preset: null,
  savedJson: null,
  selection: null,
  past: [],
  future: [],
  clipboard: null,
  issues: [],
  mode: 'design',
  layer: 'all',
  load: (preset, options) =>
    set({
      preset: structuredClone(preset),
      savedJson: options.saved ? workflowDraftFingerprint(preset) : null,
      selection: null,
      past: [],
      future: [],
      issues: []
    }),
  markSaved: (preset) =>
    set({ preset: structuredClone(preset), savedJson: workflowDraftFingerprint(preset) }),
  commit: (mutate, options = {}) => {
    const current = get().preset
    if (!current) {
      return
    }
    const next = structuredClone(current)
    mutate(next)
    next.definition.nodes = shareUnchangedNodes(current.definition.nodes, next.definition.nodes)
    set((state) => ({
      preset: next,
      past:
        options.history === false
          ? state.past
          : [...state.past, snapshot(current)].slice(-HISTORY_LIMIT),
      future: options.history === false ? state.future : []
    }))
  },
  checkpoint: () => {
    const current = get().preset
    if (current) {
      set((state) => ({
        past: [...state.past, snapshot(current)].slice(-HISTORY_LIMIT),
        future: []
      }))
    }
  },
  select: (selection) => set({ selection }),
  undo: () => {
    const { preset, past, future } = get()
    const previous = past.at(-1)
    if (!preset || !previous) {
      return
    }
    set({
      preset: { ...preset, ...structuredClone(previous) },
      past: past.slice(0, -1),
      future: [snapshot(preset), ...future],
      selection: null
    })
  },
  redo: () => {
    const { preset, past, future } = get()
    const next = future[0]
    if (!preset || !next) {
      return
    }
    set({
      preset: { ...preset, ...structuredClone(next) },
      past: [...past, snapshot(preset)],
      future: future.slice(1),
      selection: null
    })
  },
  setClipboard: (clipboard) => set({ clipboard }),
  setIssues: (issues) => set({ issues }),
  setMode: (mode) => set({ mode }),
  setLayer: (layer) => set({ layer })
}))

export function isWorkflowDraftDirty(
  state: Pick<WorkflowEditorState, 'preset' | 'savedJson'>
): boolean {
  return state.preset !== null && workflowDraftFingerprint(state.preset) !== state.savedJson
}

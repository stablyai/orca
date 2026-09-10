import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

export type CanvasCardKind = 'markdown' | 'html'

export type CanvasCard = {
  id: string
  kind: CanvasCardKind
  worktreeId: string
  filePath: string
  x: number
  y: number
  width: number
  height: number
}

export type CanvasViewport = { offsetX: number; offsetY: number; zoom: number }

export const CANVAS_DEFAULT_CARD_WIDTH = 520
export const CANVAS_DEFAULT_CARD_HEIGHT = 420
export const CANVAS_MIN_CARD_WIDTH = 280
export const CANVAS_MIN_CARD_HEIGHT = 200

export type CanvasSlice = {
  canvasCardsByWorktree: Record<string, CanvasCard[]>
  canvasViewportByWorktree: Record<string, CanvasViewport>
  addCanvasCard: (
    worktreeId: string,
    card: Omit<CanvasCard, 'id' | 'worktreeId' | 'kind'>
  ) => CanvasCard | null
  removeCanvasCard: (worktreeId: string, cardId: string) => void
  updateCanvasCardGeometry: (
    worktreeId: string,
    cardId: string,
    patch: Partial<Pick<CanvasCard, 'x' | 'y' | 'width' | 'height'>>
  ) => void
  setCanvasViewport: (worktreeId: string, viewport: CanvasViewport) => void
}

export function classifyCanvasFile(filePath: string): CanvasCardKind | null {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) {
    return 'markdown'
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 'html'
  }
  return null
}

export const createCanvasSlice: StateCreator<AppState, [], [], CanvasSlice> = (set, get) => ({
  canvasCardsByWorktree: {},
  canvasViewportByWorktree: {},
  addCanvasCard: (worktreeId, card) => {
    const kind = classifyCanvasFile(card.filePath)
    if (!kind) {
      return null
    }
    // Why: re-dropping an already-pinned file focuses the existing card instead of stacking duplicates.
    const existing = (get().canvasCardsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.filePath === card.filePath
    )
    if (existing) {
      return existing
    }
    const created: CanvasCard = {
      ...card,
      kind,
      id: crypto.randomUUID(),
      worktreeId
    }
    set((state) => ({
      canvasCardsByWorktree: {
        ...state.canvasCardsByWorktree,
        [worktreeId]: [...(state.canvasCardsByWorktree[worktreeId] ?? []), created]
      }
    }))
    return created
  },
  removeCanvasCard: (worktreeId, cardId) =>
    set((state) => {
      const cards = state.canvasCardsByWorktree[worktreeId]
      if (!cards?.some((card) => card.id === cardId)) {
        return state
      }
      return {
        canvasCardsByWorktree: {
          ...state.canvasCardsByWorktree,
          [worktreeId]: cards.filter((card) => card.id !== cardId)
        }
      }
    }),
  updateCanvasCardGeometry: (worktreeId, cardId, patch) =>
    set((state) => {
      const cards = state.canvasCardsByWorktree[worktreeId]
      if (!cards?.some((card) => card.id === cardId)) {
        return state
      }
      return {
        canvasCardsByWorktree: {
          ...state.canvasCardsByWorktree,
          [worktreeId]: cards.map((card) =>
            card.id === cardId
              ? {
                  ...card,
                  ...patch,
                  width: Math.max(patch.width ?? card.width, CANVAS_MIN_CARD_WIDTH),
                  height: Math.max(patch.height ?? card.height, CANVAS_MIN_CARD_HEIGHT)
                }
              : card
          )
        }
      }
    }),
  setCanvasViewport: (worktreeId, viewport) =>
    set((state) => ({
      canvasViewportByWorktree: {
        ...state.canvasViewportByWorktree,
        [worktreeId]: viewport
      }
    }))
})

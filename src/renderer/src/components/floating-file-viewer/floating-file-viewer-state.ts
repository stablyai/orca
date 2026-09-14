import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { z } from 'zod'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { clampFloatingTerminalBounds } from '../floating-terminal/floating-terminal-panel-bounds'

const ownerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('ssh'), connectionId: z.string().min(1) }),
  z.object({
    kind: z.literal('runtime'),
    environmentId: z.string().min(1),
    executionHostId: z.custom<ExecutionHostId>(
      (value) => typeof value === 'string' && parseExecutionHostId(value) !== null
    )
  })
])
const boundsSchema = z.object({
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
})
const viewerSchema = z.object({
  id: z.string(),
  filePath: z.string().min(1),
  relativePath: z.string().min(1),
  worktreeId: z.string().min(1),
  worktreePath: z.string().min(1),
  projectName: z.string(),
  workspaceName: z.string(),
  language: z.string(),
  owner: ownerSchema,
  bounds: boundsSchema
})
const persistedSchema = z.object({ viewers: z.array(viewerSchema), hidden: z.boolean() })
export type FloatingFileViewer = z.infer<typeof viewerSchema>
type ViewerInput = Omit<FloatingFileViewer, 'id' | 'bounds'>
type ViewerState = {
  focusRequest: number
  viewers: FloatingFileViewer[]
  hidden: boolean
  open: (file: ViewerInput) => void
  close: (id: string) => void
  raise: (id: string) => void
  toggleHidden: () => void
  setBounds: (id: string, bounds: FloatingFileViewer['bounds']) => void
}

export const useFloatingFileViewers = create<ViewerState>()(
  persist(
    (set) => ({
      focusRequest: 0,
      viewers: [],
      hidden: false,
      open: (file) =>
        set((state) => {
          const id = JSON.stringify([file.owner, file.worktreeId, file.filePath])
          const existing = state.viewers.find((viewer) => viewer.id === id)
          const offset = (state.viewers.length % 8) * 28
          const viewer = existing ?? {
            ...file,
            id,
            bounds: clampFloatingTerminalBounds({
              left: 80 + offset,
              top: 100 + offset,
              width: 640,
              height: 480
            })
          }
          return {
            hidden: false,
            focusRequest: state.focusRequest + 1,
            viewers: [...state.viewers.filter((v) => v.id !== id), viewer]
          }
        }),
      close: (id) => set((state) => ({ viewers: state.viewers.filter((v) => v.id !== id) })),
      raise: (id) =>
        set((state) => {
          const viewer = state.viewers.find((v) => v.id === id)
          return viewer && state.viewers.at(-1) !== viewer
            ? { viewers: [...state.viewers.filter((v) => v.id !== id), viewer] }
            : state
        }),
      toggleHidden: () => set((state) => ({ hidden: !state.hidden })),
      setBounds: (id, bounds) =>
        set((state) => ({
          viewers: state.viewers.map((viewer) =>
            viewer.id === id ? { ...viewer, bounds: clampFloatingTerminalBounds(bounds) } : viewer
          )
        }))
    }),
    {
      name: 'orca-floating-file-viewers-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ viewers, hidden }) => ({ viewers, hidden }),
      merge: (persisted, current) => {
        const parsed = persistedSchema.safeParse(persisted)
        return parsed.success ? { ...current, ...parsed.data } : current
      }
    }
  )
)

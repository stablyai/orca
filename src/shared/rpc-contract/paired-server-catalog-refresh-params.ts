import { z } from 'zod'

/** The paired server whose catalog main reads again after the window wrote to it. */
export const PairedServerCatalogRefreshParams = z.object({
  environmentId: z.string().min(1).max(256)
})

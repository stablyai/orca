export type WorktreePathMaterializationResult = {
  supported: boolean
  warning?: string
}

export type WorktreeSharedLinks = { source: string; paths: readonly string[] }

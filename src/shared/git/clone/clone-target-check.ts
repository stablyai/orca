/** Whether a clone can go into its folder; `taken` suggests a free name beside it. */
export type CloneTargetCheck =
  | { status: 'free'; folderName: string }
  | {
      status: 'taken'
      folderName: string
      reason: 'other-repository' | 'not-empty'
      suggestedFolderName: string | null
    }

export type CloneTargetArgs = { url: string; destination: string; folderName?: string }

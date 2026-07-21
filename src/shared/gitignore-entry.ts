export const MAX_GITIGNORE_ENTRY_COUNT = 200
export const MAX_GITIGNORE_RELATIVE_PATH_LENGTH = 4096

export type GitignoreEntry = {
  relativePath: string
  isDirectory: boolean
}

export type AppendGitignoreEntriesResult = {
  added: string[]
  alreadyPresent: string[]
}

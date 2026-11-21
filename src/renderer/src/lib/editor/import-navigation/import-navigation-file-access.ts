/** Host file reads for import navigation; implementations route to the tab's owning host. */
export type ImportNavigationFileAccess = {
  /** One entry per path; false when absent or unverifiable. */
  pathsExist(paths: readonly string[]): Promise<boolean[]>
  /** Null when the path is missing, binary or unreadable. */
  readText(path: string): Promise<string | null>
  /** Absolute paths of workspace files with this exact name; empty when the host cannot search. */
  findFilesNamed?(fileName: string): Promise<string[]>
}

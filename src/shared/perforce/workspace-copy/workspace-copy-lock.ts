import { WorkspaceCopyError } from './workspace-copy-errors'

const busySources = new Set<string>()

/** One create or remove per source workspace at a time: both read and rewrite its copies folder. */
export async function withSourceLock<T>(sourceRoot: string, run: () => Promise<T>): Promise<T> {
  const key = sourceRoot.toLowerCase()
  if (busySources.has(key)) {
    throw new WorkspaceCopyError(
      'refused',
      'Another copy of this workspace is being made or removed. Wait for it to finish, then try again.'
    )
  }
  busySources.add(key)
  try {
    return await run()
  } finally {
    busySources.delete(key)
  }
}

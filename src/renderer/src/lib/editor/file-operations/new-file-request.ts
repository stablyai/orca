export type NewFileRequest = {
  id: string
  worktreePath: string
  initialDirectory: string
  disableBrowse: boolean
  create: (relativePath: string) => Promise<void>
  resolve: (relativePath: string | null) => void
}

let listener: ((request: NewFileRequest) => void) | null = null
let nextRequestId = 0

export function subscribeNewFileRequests(
  nextListener: (request: NewFileRequest) => void
): () => void {
  listener = nextListener
  return () => {
    if (listener === nextListener) {
      listener = null
    }
  }
}

export function requestNewFile(
  options: Omit<NewFileRequest, 'id' | 'resolve'>
): Promise<string | null> {
  if (!listener) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    listener?.({
      ...options,
      id: `new-file-${nextRequestId++}`,
      resolve: (relativePath) => {
        if (!settled) {
          settled = true
          resolve(relativePath)
        }
      }
    })
  })
}

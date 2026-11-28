import { opendirSync, readdirSync, type Dirent, type OpenDirOptions } from 'node:fs'
import { opendir, readdir } from 'node:fs/promises'

/** The part of fs.Dir that callers use; a real Dir satisfies it. */
export type DirectoryHandle = {
  readonly path: string
  read(): Promise<Dirent | null>
  readSync(): Dirent | null
  close(): Promise<void>
  closeSync(): void
  [Symbol.asyncIterator](): AsyncIterator<Dirent>
}

type OpenDirectoryOptions = Pick<OpenDirOptions, 'bufferSize'> & { encoding?: 'utf8' }

// Windows opendir can report a failed open as success with a null handle, which crashes the
// process (#50875); readdir reports the error. Elsewhere keep opendir's streaming reads.
export async function openDirectory(
  path: string,
  options?: OpenDirectoryOptions
): Promise<DirectoryHandle> {
  if (process.platform === 'win32') {
    return new ListedDirectory(path, await readdir(path, { withFileTypes: true }))
  }
  return opendir(path, options)
}

export function openDirectorySync(path: string, options?: OpenDirectoryOptions): DirectoryHandle {
  if (process.platform === 'win32') {
    return new ListedDirectory(path, readdirSync(path, { withFileTypes: true }))
  }
  return opendirSync(path, options)
}

class ListedDirectory implements DirectoryHandle {
  private next = 0
  private closed = false

  constructor(
    readonly path: string,
    private readonly entries: Dirent[]
  ) {}

  readSync(): Dirent | null {
    if (this.closed || this.next >= this.entries.length) {
      return null
    }
    return this.entries[this.next++]
  }

  async read(): Promise<Dirent | null> {
    return this.readSync()
  }

  closeSync(): void {
    this.closed = true
  }

  async close(): Promise<void> {
    this.closeSync()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Dirent> {
    try {
      for (let entry = this.readSync(); entry; entry = this.readSync()) {
        yield entry
      }
    } finally {
      // Matches Dir: iteration closes the handle, including on break.
      this.closeSync()
    }
  }
}

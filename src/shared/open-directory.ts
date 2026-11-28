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

const LISTED_BATCH_SIZE = 32

class ListedDirectory implements DirectoryHandle {
  private next = 0

  constructor(
    readonly path: string,
    private entries: Dirent[]
  ) {}

  readSync(): Dirent | null {
    return this.next < this.entries.length ? this.entries[this.next++] : null
  }

  async read(): Promise<Dirent | null> {
    // Dir refills its 32-entry buffer with real I/O; yield as often so long walks don't starve the loop.
    if (this.next > 0 && this.next % LISTED_BATCH_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return this.readSync()
  }

  closeSync(): void {
    // Drop the listing now; a caller may keep the handle after an early break.
    this.entries = []
  }

  async close(): Promise<void> {
    this.closeSync()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Dirent> {
    try {
      for (let entry = await this.read(); entry; entry = await this.read()) {
        yield entry
      }
    } finally {
      // Matches Dir: iteration closes the handle, including on break.
      this.closeSync()
    }
  }
}

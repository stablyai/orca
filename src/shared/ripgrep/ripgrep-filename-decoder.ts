export class RipgrepFilenameError extends Error {}

export class RipgrepFilenameEncodingError extends RipgrepFilenameError {
  constructor() {
    super('File listing contains a filename that is not valid UTF-8')
    this.name = 'RipgrepFilenameEncodingError'
  }
}

/** Replacement decoding would return a different, potentially existing filename. */
export class RipgrepFilenameDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

  constructor(
    private readonly onError: (error: Error) => void = throwFilenameError,
    private readonly rejectBackslash = false
  ) {}

  decode(chunk: Buffer | string): string | null {
    try {
      const decoded = this.decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, {
        stream: true
      })
      if (this.rejectBackslash && decoded.includes('\\')) {
        throw new RipgrepFilenameError(
          'WSL filenames containing a backslash cannot be opened through Windows paths'
        )
      }
      return decoded
    } catch (error) {
      this.onError(
        error instanceof RipgrepFilenameError ? error : new RipgrepFilenameEncodingError()
      )
      return null
    }
  }

  finish(): boolean {
    try {
      this.decoder.decode()
      return true
    } catch {
      this.onError(new RipgrepFilenameEncodingError())
      return false
    }
  }
}

function throwFilenameError(error: Error): never {
  throw error
}

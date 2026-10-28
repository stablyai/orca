// Two independent FNV lanes plus length reduce collisions that could hide external writes and permit silent overwrite (#7265).
export function getDiskBaselineSignature(content: string): string {
  return new DiskBaselineSignatureBuilder().update(content).digest()
}

/** The same signature fed in pieces, so a large file can be hashed between yields. */
export class DiskBaselineSignatureBuilder {
  private hashA = 2166136261
  private hashB = 84696351
  private length = 0

  update(chunk: string): this {
    let hashA = this.hashA
    let hashB = this.hashB
    for (let i = 0; i < chunk.length; i += 1) {
      const code = chunk.charCodeAt(i)
      hashA ^= code
      hashA = Math.imul(hashA, 16777619)
      hashB = Math.imul(hashB ^ code, 1099511627)
    }
    this.hashA = hashA
    this.hashB = hashB
    this.length += chunk.length
    return this
  }

  digest(): string {
    return `${(this.hashA >>> 0).toString(16)}-${(this.hashB >>> 0).toString(16)}-${this.length.toString(16)}`
  }
}

/** UTF-16 length a disk baseline signature was taken over, or null when it is not one. */
export function diskBaselineSignatureLength(signature: string): number | null {
  const match = /^[0-9a-f]{1,8}-[0-9a-f]{1,8}-([0-9a-f]{1,13})$/.exec(signature)
  if (!match) {
    return null
  }
  const length = Number.parseInt(match[1], 16)
  return Number.isSafeInteger(length) ? length : null
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Signature of what disk holds after a UTF-8 write of `content`, which stores each lone surrogate as U+FFFD. */
export function getWrittenContentDiskSignature(content: string): string {
  return getDiskBaselineSignature(content.replace(LONE_SURROGATE, '�'))
}

/** Why sound: every UTF-8-decoded unit, U+FFFD for a malformed run included, consumes 1–3 bytes. */
export function utf8ByteSizeCanDecodeToLength(byteSize: number, utf16Length: number): boolean {
  return byteSize >= utf16Length && byteSize <= utf16Length * 3
}

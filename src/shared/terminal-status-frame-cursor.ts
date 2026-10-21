const STATUS_PREFIX = '\x1b]9999;'
const MAX_PENDING_STATUS = 64 * 1024

/** Skips status bodies without retaining them; emitted spans keep their original chunk offsets. */
export class TerminalStatusFrameCursor {
  private prefix = ''
  private bodyLength = 0
  private escaped = false
  private quarantined = false

  reset(): void {
    this.prefix = ''
    this.bodyLength = 0
    this.escaped = false
    this.quarantined = false
  }

  scan(
    data: string,
    emit: (span: string, start: number) => boolean | void,
    uncertain: () => void
  ): void {
    const prior = this.prefix.length
    const input = this.prefix + data
    this.prefix = ''
    let offset = 0
    while (offset < input.length) {
      if (this.bodyLength > 0) {
        let end = offset
        while (end < input.length) {
          const code = input.charCodeAt(end++)
          if (code === 7 || (this.escaped && code === 92)) {
            offset = end
            this.bodyLength = 0
            this.escaped = false
            this.quarantined = false
            break
          }
          this.escaped = code === 27
        }
        if (this.bodyLength > 0) {
          this.bodyLength = Math.min(
            MAX_PENDING_STATUS + 1,
            this.bodyLength + input.length - offset
          )
          if (this.bodyLength > MAX_PENDING_STATUS && !this.quarantined) {
            this.quarantined = true
            uncertain()
          }
          return
        }
        continue
      }
      const start = input.indexOf(STATUS_PREFIX, offset)
      if (start !== -1) {
        if (start > offset && emit(input.slice(offset, start), offset - prior) === false) {
          return
        }
        this.bodyLength = STATUS_PREFIX.length
        offset = start + STATUS_PREFIX.length
        continue
      }
      let suffix = Math.min(STATUS_PREFIX.length - 1, input.length - offset)
      while (suffix > 0 && !STATUS_PREFIX.startsWith(input.slice(input.length - suffix))) {
        suffix -= 1
      }
      const end = input.length - suffix
      if (end > offset && emit(input.slice(offset, end), offset - prior) === false) {
        return
      }
      this.prefix = input.slice(end)
      return
    }
  }
}

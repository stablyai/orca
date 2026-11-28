// `ouro chat` reports idle over OSC 7501 once its composer takes input, and clears its row on exit. Its agent
// picker runs before the chat and reports nothing, and a shell never writes 7501, so the paste cannot answer the picker.
const OURO_STATUS_REPORT = '\x1b]7501;'
// Longest unterminated report carried into the next read: OSC 7501 caps a whole sequence at 4096 bytes.
const MAX_CARRIED_REPORT_CHARS = 4096
/* oxlint-disable-next-line no-control-regex -- OSC terminators are BEL or ESC \ */
const OSC_TERMINATOR_RE = /\x07|\x1b\\/g

/** Reads each OSC 7501 report on its own; ready only when the chunk's last report has exact `state=idle` and `app=ouro` fields. */
export function createOuroStatusReportScanner(): { observe: (data: string) => { ready: boolean } } {
  // A split report prefix, or an open report not yet terminated.
  let carry = ''
  return {
    observe(data: string): { ready: boolean } {
      const input = carry + data
      carry = ''
      // A later report in the same chunk (working, clear) overrides an earlier idle one.
      let ready = false
      let index = 0
      while (index < input.length) {
        const start = input.indexOf(OURO_STATUS_REPORT, index)
        if (start === -1) {
          carry = splitPrefixTail(input, index)
          break
        }
        const payloadStart = start + OURO_STATUS_REPORT.length
        OSC_TERMINATOR_RE.lastIndex = payloadStart
        const end = OSC_TERMINATOR_RE.exec(input)
        if (!end) {
          const open = input.slice(start)
          carry = open.length <= MAX_CARRIED_REPORT_CHARS ? open : ''
          break
        }
        ready = isOuroIdleReport(input.slice(payloadStart, end.index))
        index = end.index + end[0].length
      }
      return { ready }
    }
  }
}

function isOuroIdleReport(payload: string): boolean {
  const fields = payload.split(':')
  return fields.includes('state=idle') && fields.includes('app=ouro')
}

/** The input's tail that could begin a report split across reads. */
function splitPrefixTail(input: string, from: number): string {
  const maxLength = Math.min(OURO_STATUS_REPORT.length - 1, input.length - from)
  for (let length = maxLength; length > 0; length--) {
    if (OURO_STATUS_REPORT.startsWith(input.slice(-length))) {
      return input.slice(-length)
    }
  }
  return ''
}

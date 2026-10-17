// Whether output leaves an OSC string open, so a BEL that follows is its terminator.
const OSC_INTRODUCER = '\x1b]'

function endsOscString(code: number): boolean {
  // BEL and ST (ESC \) terminate it; CAN, SUB and any other ESC abort it.
  return code === 0x07 || code === 0x18 || code === 0x1a || code === 0x1b
}

/** Whether `data` leaves an OSC string open, given whether one was open before it. */
export function oscStringOpenAfter(data: string, openBefore: boolean): boolean {
  const introducer = data.lastIndexOf(OSC_INTRODUCER)
  const from = introducer === -1 ? 0 : introducer + OSC_INTRODUCER.length
  if (introducer === -1 && !openBefore) {
    return false
  }
  for (let index = from; index < data.length; index += 1) {
    if (endsOscString(data.charCodeAt(index))) {
      return false
    }
  }
  return true
}

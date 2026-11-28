// Separates a spec's probe marker from recorded terminal input, even when the
// PTY splits the marker across reads.

/** @param {string} probe */
function createInputProbeSplitter(probe) {
  let held = ''
  /** @param {string} chunk */
  return (chunk) => {
    let text = held + chunk
    held = ''
    let logged = ''
    let probes = 0
    let index = text.indexOf(probe)
    while (index !== -1) {
      logged += text.slice(0, index)
      probes += 1
      text = text.slice(index + probe.length)
      index = text.indexOf(probe)
    }
    // Why: hold back a tail that may be the start of a probe finished by the next read.
    for (let length = Math.min(probe.length - 1, text.length); length > 0; length--) {
      const tail = text.slice(text.length - length)
      if (probe.startsWith(tail)) {
        held = tail
        text = text.slice(0, text.length - length)
        break
      }
    }
    return { logged: logged + text, probes }
  }
}

module.exports = { createInputProbeSplitter }

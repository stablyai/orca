import remarkMath from 'remark-math'
import type { Processor } from 'unified'
import type { Code, Construct, State } from 'micromark-util-types'

function isDelimiterWhitespace(code: Code): boolean {
  return code !== null && (code < 0 || /\s/u.test(String.fromCodePoint(code)))
}

function withCurrencyBoundaries(construct: Construct): Construct {
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      let opening = 0
      let bodyStarted = false
      let lastBodyCode: Code = null
      let finished = false
      const reject: State = (code) => {
        finished = true
        return nok(code)
      }
      const accept: State = (code) => {
        if (
          opening === 1 &&
          (isDelimiterWhitespace(lastBodyCode) || (code !== null && code >= 48 && code <= 57))
        ) {
          return reject(code)
        }
        finished = true
        return ok(code)
      }
      const wrap =
        (state: State): State =>
        (code) => {
          if (!bodyStarted) {
            if (code === 36) {
              opening++
            } else {
              bodyStarted = true
              if (opening === 1 && isDelimiterWhitespace(code)) {
                return reject(code)
              }
            }
          }
          const next = state(code)
          if (code !== 36) {
            lastBodyCode = code
          }
          return next && !finished ? wrap(next) : next
        }
      // Micromark rolls rejected constructs back, preserving ordinary Markdown parsing.
      return wrap(construct.tokenize.call(this, effects, accept, reject))
    }
  }
}

export function remarkCurrencyMath(this: Processor): void {
  remarkMath.call(this)
  const extensions = this.data().micromarkExtensions
  const extension = extensions?.at(-1)
  const constructs = extension?.text?.[36]
  if (!extensions || !extension || !constructs) {
    return
  }
  extensions[extensions.length - 1] = {
    ...extension,
    text: {
      ...extension.text,
      36: Array.isArray(constructs)
        ? constructs.map(withCurrencyBoundaries)
        : withCurrencyBoundaries(constructs)
    }
  }
}

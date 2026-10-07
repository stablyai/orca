import remarkMath from 'remark-math'
import type { Plugin } from 'unified'

/** Single-dollar math must touch its content and must not close before a price digit. */
export const remarkChatMath: Plugin = function () {
  this.use(remarkMath)
  // Run after remarkMath has installed its syntax extension.
  this.use(function currencySafeDelimiters() {
    const extensions = this.data().micromarkExtensions ?? []
    for (const extension of extensions) {
      const dollar = extension.text?.[36]
      if (!dollar) {
        continue
      }
      const constructs = Array.isArray(dollar) ? dollar : [dollar]
      for (const construct of constructs) {
        if (construct.name !== 'mathText') {
          continue
        }
        const tokenize = construct.tokenize
        construct.tokenize = function (effects, ok, nok) {
          const start = this.events.length
          return tokenize.call(
            this,
            effects,
            (code) => {
              const token = this.events[start]?.[1]
              if (!token) {
                return nok(code)
              }
              const source = this.sliceSerialize(token)
              if (
                !source.startsWith('$$') &&
                (/^\$\s|\s\$$/.test(source) || (code !== null && code >= 48 && code <= 57))
              ) {
                return nok(code)
              }
              return ok(code)
            },
            nok
          )
        }
      }
    }
  })
}

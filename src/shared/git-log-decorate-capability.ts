// Why: %(decorate) arrived in Git 2.43; older binaries print the placeholder verbatim and exit zero.
export const GIT_LOG_DECORATE_PLACEHOLDER = '%(decorate:prefix=,suffix=,separator=%x1f)'

const UNEXPANDED_DECORATE_ECHO = GIT_LOG_DECORATE_PLACEHOLDER.replace('%x1f', '\x1f')

export function hasUnsupportedLogDecorateEcho(decorations: readonly string[]): boolean {
  return decorations.some((decoration) => decoration === UNEXPANDED_DECORATE_ECHO)
}

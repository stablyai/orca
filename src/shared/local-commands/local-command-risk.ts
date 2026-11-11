import { hasNonAsciiCharacters } from './local-command-contract'

const SHELLS = '(?:ba|z|da|k)?sh'
// `… | sh`, `… | sudo bash -s`, `bash -c "$(curl …)"`, `bash <(curl …)`.
const PIPE_TO_SHELL = [
  new RegExp(`\\|\\s*(?:sudo\\s+)?(?:\\S*/)?${SHELLS}\\b`),
  new RegExp(`\\b${SHELLS}\\s+(?:-\\w+\\s+)*-c\\s+["']?\\$\\(`),
  new RegExp(`\\b${SHELLS}\\s+<\\(`)
]
const SUDO = /(?:^|[\s;&|(`])sudo\b/
const SUBSTITUTION = /\$\(|`/

export type LocalCommandRisk = {
  nonAscii: boolean
  /** Downloads or builds a script and runs it, so the person can't see what it does. */
  pipesToShell: boolean
  usesSudo: boolean
  substitution: boolean
  /** "Always allow" would approve whatever this expands to later; only Allow once is offered. */
  alwaysAllowBlocked: boolean
}

export function assessLocalCommandRisk(command: string, cwd = ''): LocalCommandRisk {
  const nonAscii = hasNonAsciiCharacters(command) || hasNonAsciiCharacters(cwd)
  const pipesToShell = PIPE_TO_SHELL.some((pattern) => pattern.test(command))
  const usesSudo = SUDO.test(command)
  const substitution = SUBSTITUTION.test(command)
  return {
    nonAscii,
    pipesToShell,
    usesSudo,
    substitution,
    alwaysAllowBlocked: nonAscii || pipesToShell || usesSudo || substitution
  }
}

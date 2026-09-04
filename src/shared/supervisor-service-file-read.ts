/**
 * Reading values back out of an installed supervisor service definition.
 *
 * Deliberately not an XML or INI parser: the audit must work on a hand-edited file that a
 * strict parser would reject outright, since a hand-edited file is exactly the one most
 * likely to be wrong.
 */
import type { SupervisorPlatform, SupervisorScope } from './supervisor-service-render'

export type SupervisorServiceFile = {
  path: string
  text: string
  platform: SupervisorPlatform
  scope: SupervisorScope
}

/** systemd `Key=value`, ignoring comments. Last assignment wins, as systemd itself does. */
export function readSystemdKey(text: string, key: string): string | null {
  let found: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    const match = new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line)
    if (match) {
      found = match[1].trim()
    }
  }
  return found
}

/**
 * `<key>Name</key>` followed by its value element. Deliberately not an XML parser: the
 * audit must work on a hand-edited plist that a strict parser would reject outright.
 */
export function readPlistBoolean(text: string, key: string): boolean | null {
  const match = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<(true|false)\\s*/>`, 'i').exec(text)
  return match ? match[1].toLowerCase() === 'true' : null
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

/**
 * The inverse of the generator's `xmlEscape`, and it exists for the same reason the systemd
 * splitter does: a read is only correct if it undoes what the write did. A data root holding
 * `&` is written `&amp;`, and an undecoded read then compares `/srv/a&amp;b` against the
 * caller's `/srv/a&b` — reporting the generator's own plist as a mismatched data root, and
 * stat-ing an ExecStart path that was never on disk.
 *
 * One pass over the named entities, so `&amp;lt;` decodes to the literal `&lt;` rather than
 * being decoded twice into `<`. Numeric entities are left alone: the generator never emits
 * one, and half-decoding a hand-edited path is worse than not touching it.
 */
function xmlUnescape(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    return XML_ENTITIES[entity] ?? whole
  })
}

export function readPlistString(text: string, key: string): string | null {
  const match = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`, 'i').exec(text)
  return match ? xmlUnescape(match[1].trim()) : null
}

/** Every `<string>` in an already-narrowed fragment, decoded the same way. */
function readPlistStrings(fragment: string): string[] {
  return [...fragment.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => xmlUnescape(match[1]))
}

/**
 * Splits a systemd command line the way systemd does, rather than on whitespace.
 *
 * The generator quotes any path containing a space, so a naive split hands back `"/opt/my`
 * as the interpreter and the caller then stats a path that was never named — reporting a
 * unit orcad itself wrote as pointing at a missing binary. Inside double quotes systemd
 * applies C-style escapes, so one round of those is undone here too.
 */
export function splitSystemdCommandLine(command: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (char === '\\' && quote !== "'" && i + 1 < command.length) {
      current += command[i + 1]
      i += 1
      started = true
    } else if (quote === null && (char === '"' || char === "'")) {
      quote = char
      started = true
    } else if (char === quote) {
      quote = null
    } else if (quote === null && /\s/.test(char)) {
      if (started) {
        words.push(current)
      }
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) {
    words.push(current)
  }
  return words
}

/** systemd writes `Environment=NAME=value`; the plist nests it under EnvironmentVariables. */
export function readPinnedUserData(file: SupervisorServiceFile): string | null {
  if (file.platform === 'systemd') {
    for (const raw of file.text.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('#')) {
        continue
      }
      const match = /^Environment\s*=\s*(.*)$/.exec(line)
      if (!match) {
        continue
      }
      // Tokenized rather than regexed: one Environment line may carry several assignments,
      // and the generator quotes this one whenever the root contains a space.
      for (const assignment of splitSystemdCommandLine(match[1])) {
        if (assignment.startsWith('ORCA_USER_DATA=')) {
          return assignment.slice('ORCA_USER_DATA='.length).trim()
        }
      }
    }
    return null
  }
  const dict = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/i.exec(file.text)
  return dict ? readPlistString(dict[1], 'ORCA_USER_DATA') : null
}

/**
 * The endpoint the service will actually try to bind, read from the file rather than from
 * the caller's flags — probing a default port while the file names another one reports the
 * wrong answer with full confidence.
 */
export function readConfiguredEndpoint(
  file: SupervisorServiceFile
): { bind: string; port: number } | null {
  // Why scoped to ProgramArguments and not every <string> in the plist: the data root and
  // log path are strings too, and joining them all lets an unrelated value supply the port.
  const programArguments = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(
    file.text
  )?.[1]
  const command =
    file.platform === 'systemd'
      ? (readSystemdKey(file.text, 'ExecStart') ?? '')
      : readPlistStrings(programArguments ?? '').join(' ')
  const port = Number(/--port[\s=]+(\d+)/.exec(command)?.[1])
  if (!Number.isInteger(port)) {
    return null
  }
  return { bind: /--bind[\s=]+(\S+)/.exec(command)?.[1] ?? '127.0.0.1', port }
}

/**
 * The interpreter and script an installed definition will try to exec.
 *
 * Split out from the endpoint read because the caller stats these: a unit can be perfectly
 * well-formed and name a path that no longer exists, which is what a version-scoped
 * interpreter becomes one package-manager upgrade later.
 */
export function readExecTarget(
  file: SupervisorServiceFile
): { interpreter: string; script: string | null } | null {
  const words =
    file.platform === 'systemd'
      ? splitSystemdCommandLine(readSystemdKey(file.text, 'ExecStart') ?? '')
      : readPlistStrings(
          /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(file.text)?.[1] ??
            ''
        )
  // systemd allows `-`, `@`, `+`, `!` prefixes on ExecStart; strip them off the binary.
  const interpreter = words[0]?.replace(/^[-@+!:]+/, '') ?? ''
  if (!interpreter) {
    return null
  }
  return { interpreter, script: words.slice(1).find((word) => !word.startsWith('-')) ?? null }
}

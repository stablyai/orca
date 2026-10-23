import { quoteCmdDoubleQuoted } from './shell-argument-quoting'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { normalizeAiVaultResumeFilePath } from './ai-vault-resume-path'

export type HermesSessionSource = {
  homeDir: string
  rootDir: string
  profileName: string
}

function parentPath(value: string): string {
  const separator = /^[A-Za-z]:[\\/]|^\\\\/.test(value)
    ? Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
    : value.lastIndexOf('/')
  if (separator === 2 && /^[A-Za-z]:/.test(value)) {
    return value.slice(0, 3)
  }
  return value.slice(0, separator === 0 ? 1 : separator)
}

function pathName(value: string): string {
  return value.slice(parentPath(value).length).replace(/^[\\/]/, '')
}

export function hermesSessionSourceFromFilePath(
  filePath: string | null | undefined,
  platform?: NodeJS.Platform
): HermesSessionSource | null {
  if (!filePath) {
    return null
  }
  const sourcePath = (platform && normalizeAiVaultResumeFilePath(filePath, platform)) || filePath
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(sourcePath)) {
    return null
  }
  const fragment = sourcePath.lastIndexOf('#')
  const databasePath = fragment > 0 ? sourcePath.slice(0, fragment) : ''
  const fileName = pathName(sourcePath)
  let homeDir: string
  if (pathName(databasePath) === 'state.db' && fragment < sourcePath.length - 1) {
    homeDir = parentPath(databasePath)
  } else if (
    fileName.startsWith('session_') &&
    /^session_.+\.json$/i.test(fileName) &&
    pathName(parentPath(sourcePath)) === 'sessions'
  ) {
    homeDir = parentPath(parentPath(sourcePath))
  } else {
    return null
  }
  const profilesDir = parentPath(homeDir)
  const profileName = pathName(homeDir)
  if (pathName(profilesDir) === 'profiles') {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileName) || profileName === 'default') {
      return null
    }
    return { homeDir, rootDir: parentPath(profilesDir), profileName }
  }
  return { homeDir, rootDir: homeDir, profileName: 'default' }
}

const HERMES_VALUELESS_RESUME_FLAGS = new Set([
  '--tui',
  '--native',
  '--tui-native',
  '--no-restore-cwd',
  '--cli',
  '--verbose',
  '-v',
  '--quiet',
  '-Q',
  '--worktree',
  '-w',
  '--accept-hooks',
  '--checkpoints',
  '--yolo',
  '--pass-session-id',
  '--ignore-user-config',
  '--ignore-rules',
  '--safe-mode',
  '--dev'
])

export function buildSourceAwareHermesCommand(
  command: string,
  source: HermesSessionSource,
  shell: AgentStartupShell,
  platform: NodeJS.Platform
): string {
  const parsed = tokenizeStartupCommand(command, shell)
  const fail = (): never => {
    throw new Error('Cannot safely select this Hermes session store with the configured command.')
  }
  // Hermes expands environment references again before selecting its profile.
  if (/\$(?:[A-Za-z_]|\{)/.test(source.rootDir)) {
    return fail()
  }
  if (platform === 'win32' && source.rootDir.includes('%')) {
    return fail()
  }
  if (shell === 'cmd' && /[%!\r\n"]/.test(source.rootDir)) {
    return fail()
  }
  if (!parsed.ok) {
    return fail()
  }
  const { tokens, spans } = parsed
  if (
    spans.some(
      (span, index) =>
        span.divergesFromShell && !(shell === 'powershell' && index === 0 && tokens[0] === '&')
    )
  ) {
    return fail()
  }
  for (let index = 1; index < spans.length; index++) {
    if (!/^[ \t]*$/.test(command.slice(spans[index - 1].end, spans[index].start))) {
      return fail()
    }
  }
  const basename = (token: string): string => token.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  let executable = shell === 'powershell' && tokens[0] === '&' ? 1 : 0
  while (shell === 'posix' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[executable] ?? '')) {
    executable++
  }
  if (tokens[executable] === 'env') {
    if (shell !== 'posix') {
      return fail()
    }
    executable++
    if (tokens[executable] === '--') {
      executable++
    }
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[executable] ?? '')) {
      executable++
    }
  }
  if (tokens[executable] === 'sudo') {
    if (shell !== 'posix') {
      return fail()
    }
    executable++
    while (tokens[executable]?.startsWith('-') && tokens[executable] !== '--') {
      if (['-u', '--user', '-g', '--group'].includes(tokens[executable])) {
        executable += 2
      } else if (['-E', '-H', '-n'].includes(tokens[executable])) {
        executable++
      } else {
        return fail()
      }
    }
    if (tokens[executable] === '--') {
      executable++
    }
  }
  if (tokens[executable] === 'uv' && tokens[executable + 1] === 'run') {
    executable += 2
  }
  if (!/^hermes(?:\.(?:exe|cmd|bat))?$/.test(basename(tokens[executable] ?? ''))) {
    return fail()
  }
  const removed = new Set<number>()
  for (let index = executable + 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '--') {
      return fail()
    }
    if (token === '--continue' || token === '-c') {
      if (tokens[index + 1] && !tokens[index + 1].startsWith('-')) {
        index++
      }
    } else if (token === '--profile' || token === '-p' || token === '--resume' || token === '-r') {
      if (!tokens[index + 1] || tokens[index + 1].startsWith('-')) {
        return fail()
      }
      removed.add(index)
      removed.add(++index)
    } else if (token.startsWith('--profile=') || token.startsWith('--resume=')) {
      removed.add(index)
    } else if (
      token.startsWith('-') &&
      !token.includes('=') &&
      !HERMES_VALUELESS_RESUME_FLAGS.has(token)
    ) {
      index++
    } else if (!token.startsWith('-') && token !== 'chat') {
      return fail()
    }
  }
  let rewritten = command
  for (const index of [...removed].sort((a, b) => b - a)) {
    rewritten = rewritten.slice(0, spans[index].start) + rewritten.slice(spans[index].end)
  }
  const end = spans[executable].end
  rewritten = `${rewritten.slice(0, end)} --profile ${quoteStartupArg(source.profileName, shell)}${rewritten.slice(end)}`
  if (shell === 'posix') {
    const start = spans[executable].start
    return `${rewritten.slice(0, start)}env ${quoteStartupArg(`HERMES_HOME=${source.rootDir}`, shell)} ${rewritten.slice(start)}`
  }
  if (shell === 'powershell') {
    const invocation = tokens[0] === '&' ? rewritten : `& ${rewritten}`
    return `$env:HERMES_HOME=${quoteStartupArg(source.rootDir, shell)}; ${invocation}`
  }
  return `set ${quoteCmdDoubleQuoted(`HERMES_HOME=${source.rootDir}`)} && ${rewritten}`
}

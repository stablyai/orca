import { hasControlByte } from '../../../../../../shared/agent-launch/startup/startup-line-prompt-carry'
import { isWindowsAbsolutePathLike } from '../../../../../../shared/file-access/cross-platform-path'
import { parseWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import { quotePowerShellLiteral } from '../../../../../../shared/shell/launch/powershell-native-argument'
import { quotePosixShell } from '../../../../../../shared/shell/launch/shell-argument-quoting'

type ScriptLaunch = { command: string; startupCwd: string; shell?: 'powershell.exe' }

export function buildFileExplorerScriptLaunch(
  path: string,
  platform: NodeJS.Platform,
  windowsHost = false
): ScriptLaunch | null {
  if (hasControlByte(path)) {
    return null
  }
  if (platform === 'win32') {
    const batch = /\.(?:bat|cmd)$/i.test(path)
    if (
      (!batch && !/\.ps1$/i.test(path)) ||
      !isWindowsAbsolutePathLike(path) ||
      /["<>|?*]/.test(path) ||
      // cmd can expand these again and cannot keep a UNC working directory.
      (batch && (/[%!]/.test(path) || !/^[A-Za-z]:/.test(path)))
    ) {
      return null
    }
    const scriptPath = path.replaceAll('/', '\\')
    const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return {
      command: `& ${quotePowerShellLiteral(scriptPath)}`,
      startupCwd: path.slice(0, separator === 2 ? 3 : separator),
      shell: 'powershell.exe'
    }
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    return null
  }
  const interpreter = /\.(sh|bash|zsh)$/i.exec(path)?.[1].toLowerCase()
  const wslPath = windowsHost ? parseWslUncPath(path) : null
  const scriptPath = wslPath?.linuxPath ?? path
  if (!interpreter || !scriptPath.startsWith('/')) {
    return null
  }
  const separator = wslPath
    ? Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    : path.lastIndexOf('/')
  return {
    command: buildPosixScriptCommand(interpreter, scriptPath),
    startupCwd: path.slice(0, Math.max(1, separator))
  }
}

function buildPosixScriptCommand(interpreter: string, scriptPath: string): string {
  // Carry apostrophes, backslashes, and history metacharacters as data across login shells.
  const literal = scriptPath.replace(/['\\!\u2018\u2019\u201A\u201B]/g, (char) =>
    Array.from(
      new TextEncoder().encode(char),
      (byte) => `\\0${byte.toString(8).padStart(3, '0')}`
    ).join('')
  )
  // Prefer the executable's shebang; an absolute argument cannot retarget on cwd fallback.
  return `/bin/sh -c 'script=$(printf %b "$1"); if [ -x "$script" ]; then exec "$script"; fi; exec ${interpreter} "$script"' sh ${quotePosixShell(literal)}`
}

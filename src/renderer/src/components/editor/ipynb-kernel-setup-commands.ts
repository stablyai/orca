import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { venvInterpreterSegments } from '../../../../shared/notebook-venv-location'
import { quotePowerShellLiteral } from '../../../../shared/powershell-native-argument'

/** Quotes a path for a shell; single quotes are literal in POSIX shells and PowerShell. */
function shellQuote(path: string, windows: boolean): string {
  return windows ? quotePowerShellLiteral(path) : `'${path.replaceAll("'", "'\\''")}'`
}

/** PowerShell runs a quoted program path only through `&`. */
function shellProgram(path: string, windows: boolean): string {
  return windows ? `& ${shellQuote(path, windows)}` : shellQuote(path, windows)
}

/** Install's command as a shell line to copy; Install itself spawns without a shell. */
export function ipykernelInstallCommand(
  python: string,
  windows = getRendererAppPlatform() === 'win32'
): string {
  return `${shellProgram(python, windows)} -m pip install -U ipykernel`
}

/** Creating the notebook's venv as a shell line to copy, mirroring `createVirtualEnvironment`. */
export function venvSetupCommand(
  python: string,
  venvParent: string,
  windows = getRendererAppPlatform() === 'win32'
): string {
  const separator = windows ? '\\' : '/'
  const venv = `${venvParent.replace(/[\\/]$/, '')}${separator}.venv`
  const interpreter = [venv, ...venvInterpreterSegments(windows)].join(separator)
  const create = `${shellProgram(python, windows)} -m venv ${shellQuote(venv, windows)}`
  const install = ipykernelInstallCommand(interpreter, windows)
  // Windows PowerShell 5.1 has no `&&`; `$?` stops the install when venv failed.
  return windows ? `${create}; if ($?) { ${install} }` : `${create} && ${install}`
}

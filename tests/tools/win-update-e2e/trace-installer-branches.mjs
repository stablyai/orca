import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const builderRoot = path.dirname(builderRequire.resolve('app-builder-lib/package.json'))
const processChecks = path.join(
  builderRoot,
  'templates/nsis/include/allowOnlyOneInstallerInstance.nsh'
)
const hooks = fileURLToPath(
  new URL('../../../config/nsis/orca-installer-hooks.nsh', import.meta.url)
)

// CI-only patch: the installer and its embedded uninstaller share these macros.
const traceMacro = `
!macro ORCA_E2E_TRACE TEXT
  Push $R8
  Push $R9
  StrCpy $R8 0
  \${if} \${Errors}
    StrCpy $R8 1
  \${endIf}
  ClearErrors
  ReadEnvStr $R9 ORCA_E2E_NSIS_TRACE
  \${if} $R9 != ""
    FileOpen $R9 "$R9" a
    \${ifNot} \${Errors}
      FileSeek $R9 0 END
      FileWrite $R9 "$EXEPATH | $CMDLINE | dir=$INSTDIR | \${TEXT}$\\r$\\n"
      FileClose $R9
    \${endIf}
  \${endIf}
  ClearErrors
  \${if} $R8 == 1
    SetErrors
  \${endIf}
  Pop $R9
  Pop $R8
!macroend
`

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`Expected one NSIS trace anchor: ${anchor}`)
  }
  return source.replace(anchor, () => replacement)
}

function insertAfter(source, anchor, insertion) {
  return replaceOnce(source, anchor, `${anchor}\n${insertion}`)
}

let checks = readFileSync(processChecks, 'utf8').replaceAll('\r\n', '\n')
checks = traceMacro + checks
checks = insertAfter(
  checks,
  '  Pop $0  # Return code (0 = success, other = error)',
  '  !insertmacro ORCA_E2E_TRACE "availability=$0 powershell=$PowerShellPath"'
)
checks = replaceOnce(
  checks,
  '    Pop $0\n  ${endIf}\n\n  ${if} $0 != 0',
  '    Pop $0\n    !insertmacro ORCA_E2E_TRACE "policy=$0"\n  ${endIf}\n\n  ${if} $0 != 0'
)
checks = insertAfter(
  checks,
  '  StrCpy $IsPowerShellAvailable $0',
  '  !insertmacro ORCA_E2E_TRACE "selected-branch=$IsPowerShellAvailable (0=path,1=image)"'
)
checks = insertAfter(
  checks,
  '!macro FIND_PROCESS _FILE _RETURN',
  '  !insertmacro ORCA_E2E_TRACE "find image=${_FILE} branch=$IsPowerShellAvailable"'
)
checks = insertAfter(
  checks,
  '!macro KILL_PROCESS _FILE _FORCE',
  '  !insertmacro ORCA_E2E_TRACE "kill image=${_FILE} force=${_FORCE} branch=$IsPowerShellAvailable"'
)
checks = replaceOnce(
  checks,
  '  Pop $0\n!macroend ',
  '  Pop $0\n  !insertmacro ORCA_E2E_TRACE "kill-result=$0"\n!macroend '
)
const findCall = '!insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0'
if (checks.split(findCall).length !== 4) {
  throw new Error('Expected three find-process calls')
}
checks = checks.replaceAll(
  findCall,
  () => `${findCall}\n    !insertmacro ORCA_E2E_TRACE "find-result=$R0"`
)
let uninstall = readFileSync(hooks, 'utf8').replaceAll('\r\n', '\n')
uninstall = insertAfter(
  uninstall,
  '!macro customUnInstall',
  '  !insertmacro ORCA_E2E_TRACE "custom-uninstall entered"'
)
uninstall = insertAfter(
  uninstall,
  '  ${ifNot} ${isUpdated}',
  '    !insertmacro ORCA_E2E_TRACE "genuine-uninstall daemon sweep"'
)

if (!process.argv.includes('--check')) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') {
    throw new Error('Installer tracing may only patch a disposable Windows CI checkout')
  }
  writeFileSync(processChecks, checks)
  writeFileSync(hooks, uninstall)
}
console.log('Validated installer/uninstaller branch-trace anchors')

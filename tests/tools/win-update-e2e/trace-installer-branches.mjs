import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hooks = fileURLToPath(
  new URL('../../../config/nsis/orca-installer-hooks.nsh', import.meta.url)
)
const processCheck = fileURLToPath(
  new URL('../../../config/nsis/orca-process-check.nsh', import.meta.url)
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
let check = readFileSync(processCheck, 'utf8').replaceAll('\r\n', '\n')
check = traceMacro + check
check = replaceOnce(
  check,
  '    ${If} $R7 == 0\n    ${AndIf} $R0 <> -1',
  '    !insertmacro ORCA_E2E_TRACE "install-dir-processes=$R7 snapshot=$R0 since-grace-ms=$1 first-terminate=$2"\n    ${If} $R7 == 0\n    ${AndIf} $R0 <> -1'
)

if (!process.argv.includes('--check')) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') {
    throw new Error('Installer tracing may only patch a disposable Windows CI checkout')
  }
  writeFileSync(hooks, uninstall)
  writeFileSync(processCheck, check)
}
console.log('Validated installer/uninstaller branch-trace anchors')

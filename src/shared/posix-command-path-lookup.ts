export type PosixCommandPathLookupTarget =
  | { kind: 'literal'; value: string }
  | { kind: 'shell-variable'; name: string }

const SHELL_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function buildPosixCommandPathLookupScript(target: PosixCommandPathLookupTarget): string {
  const commandAssignment = buildCommandAssignment(target)
  // Shell command resolution can be masked by aliases, functions, and builtins, so inspect PATH.
  return [
    `_orca_lookup_command=${commandAssignment}`,
    'resolved=',
    'case "$_orca_lookup_command" in',
    '  */*)',
    '    case "$_orca_lookup_command" in',
    '      /*) _orca_lookup_candidate=$_orca_lookup_command ;;',
    '      *) _orca_lookup_candidate=${PWD%/}/$_orca_lookup_command ;;',
    '    esac',
    '    if [ -x "$_orca_lookup_candidate" ] && [ ! -d "$_orca_lookup_candidate" ]; then',
    '      resolved=$_orca_lookup_candidate',
    '    fi',
    '    ;;',
    '  *)',
    '    _orca_lookup_remaining=${PATH-}',
    '    while :; do',
    '      case "$_orca_lookup_remaining" in',
    '        *:*)',
    '          _orca_lookup_component=${_orca_lookup_remaining%%:*}',
    '          _orca_lookup_remaining=${_orca_lookup_remaining#*:}',
    '          _orca_lookup_has_more=1',
    '          ;;',
    '        *)',
    '          _orca_lookup_component=$_orca_lookup_remaining',
    '          _orca_lookup_has_more=',
    '          ;;',
    '      esac',
    '      [ -n "$_orca_lookup_component" ] || _orca_lookup_component=.',
    '      case "$_orca_lookup_component" in',
    '        /*) _orca_lookup_candidate=$_orca_lookup_component/$_orca_lookup_command ;;',
    '        *) _orca_lookup_candidate=${PWD%/}/$_orca_lookup_component/$_orca_lookup_command ;;',
    '      esac',
    '      if [ -x "$_orca_lookup_candidate" ] && [ ! -d "$_orca_lookup_candidate" ]; then',
    '        resolved=$_orca_lookup_candidate',
    '        break',
    '      fi',
    '      [ -n "$_orca_lookup_has_more" ] || break',
    '    done',
    '    ;;',
    'esac'
  ].join('\n')
}

function buildCommandAssignment(target: PosixCommandPathLookupTarget): string {
  if (target.kind === 'literal') {
    return shellQuote(target.value)
  }
  if (!SHELL_VARIABLE_NAME_PATTERN.test(target.name)) {
    throw new Error(`Invalid shell variable name: ${target.name}`)
  }
  return `\${${target.name}-}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

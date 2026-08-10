export type PosixCommandPathLookupTarget =
  | { kind: 'literal'; value: string }
  | { kind: 'shell-variable'; name: string }

export type PosixCommandPathLookupOptions = {
  /**
   * Skip PATH components under the WSL Windows-drive automount root (`/mnt/<n>`).
   * drvfs stats cross the WSL↔Windows boundary and are far slower than native
   * ext4 — especially when cold — so a Windows PATH tail can blow a probe's
   * timeout. WSL-side probes opt in; never set for SSH remotes, where `/mnt`
   * can be a real Linux mount.
   */
  skipWindowsMountDirs?: boolean
}

const SHELL_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function buildPosixCommandPathLookupScript(
  target: PosixCommandPathLookupTarget,
  options: PosixCommandPathLookupOptions = {}
): string {
  const commandAssignment = buildCommandAssignment(target)
  const windowsMountSkip =
    options.skipWindowsMountDirs === true
      ? [
          'case "$_orca_lookup_component" in',
          '  /mnt|/mnt/*)',
          // Why: continue past Windows-drive mounts; break on the final component.
          '    [ -n "$_orca_lookup_has_more" ] || break',
          '    continue',
          '    ;;',
          'esac'
        ]
      : []
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
    ...windowsMountSkip,
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

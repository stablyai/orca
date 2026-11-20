// Login profiles can rebuild PATH; re-add Orca's CLI first and Orca's own agent copies after the
// user's own entries, though ahead of the Windows-drive entries that follow them on a WSL host.
export const ORCA_CLI_POSIX_PATH_RESTORE = `if [ -n "\${ORCA_CLI_BIN_DIR:-}" ]; then
  case "\${PATH:-}" in
    "$ORCA_CLI_BIN_DIR"|"$ORCA_CLI_BIN_DIR":*) ;;
    *) export PATH="$ORCA_CLI_BIN_DIR\${PATH:+:$PATH}" ;;
  esac
fi
orca_place_agents() {
  [ -z "\${ZSH_VERSION:-}" ] || setopt localoptions shwordsplit noglob
  orca_ifs_set=\${IFS+1}; orca_ifs=\${IFS-}; IFS=:
  case $- in *f*) orca_noglob=1 ;; *) orca_noglob= ;; esac
  [ -n "\${ZSH_VERSION:-}" ] || set -f
  orca_head=; orca_tail=; orca_started=
  for orca_entry in \${PATH:-}; do
    if [ -n "$orca_entry" ]; then
      case ":$ORCA_MANAGED_AGENT_PATH:" in *":$orca_entry:"*) continue ;; esac
    fi
    orca_drive=
    for orca_mount in $ORCA_WINDOWS_DRIVE_MOUNTS; do
      [ -z "$orca_mount" ] || case "$orca_entry/" in "$orca_mount"/*) orca_drive=1 ;; esac
    done
    if [ -n "$orca_drive" ]; then
      orca_tail="\${orca_tail:+$orca_tail:}$orca_entry"
    else
      [ -z "$orca_tail" ] || { orca_head="$orca_head\${orca_started:+:}$orca_tail"; orca_started=1; orca_tail=; }
      orca_head="$orca_head\${orca_started:+:}$orca_entry"; orca_started=1
    fi
  done
  # Field splitting drops a trailing empty entry (the working directory) everywhere but zsh.
  [ -n "\${ZSH_VERSION:-}" ] || case "\${PATH:-}" in
    *:)
      [ -z "$orca_tail" ] || { orca_head="$orca_head\${orca_started:+:}$orca_tail"; orca_started=1; orca_tail=; }
      orca_head="$orca_head\${orca_started:+:}"; orca_started=1 ;;
  esac
  if [ -n "$orca_ifs_set" ]; then IFS=$orca_ifs; else unset IFS; fi
  [ -n "\${ZSH_VERSION:-}" ] || [ -n "$orca_noglob" ] || set +f
  orca_head="$orca_head\${orca_started:+:}$ORCA_MANAGED_AGENT_PATH\${orca_tail:+:$orca_tail}"
  # Assigning PATH makes zsh rehash every directory, so leave an already ordered PATH alone.
  [ "$orca_head" = "\${PATH:-}" ] || export PATH="$orca_head"
  unset orca_ifs_set orca_ifs orca_noglob orca_head orca_tail orca_started orca_entry orca_drive orca_mount
}
if [ -n "\${ORCA_MANAGED_AGENT_PATH:-}" ]; then
  if [ -n "\${ORCA_WINDOWS_DRIVE_MOUNTS:-}" ]; then
    # On a WSL host, Orca's copies go after the user's own entries, ahead of the Windows-drive ones after them.
    orca_place_agents
  else
    orca_missing=; orca_rest="$ORCA_MANAGED_AGENT_PATH:"
    while [ -n "$orca_rest" ]; do
      orca_entry="\${orca_rest%%:*}"; orca_rest="\${orca_rest#*:}"
      case ":\${PATH:-}:" in
        *":$orca_entry:"*) ;;
        *) [ -z "$orca_entry" ] || orca_missing="\${orca_missing:+$orca_missing:}$orca_entry" ;;
      esac
    done
    [ -z "$orca_missing" ] || export PATH="\${PATH:+$PATH:}$orca_missing"
    unset orca_missing orca_rest orca_entry
  fi
fi
unset -f orca_place_agents`

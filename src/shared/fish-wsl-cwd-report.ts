/**
 * The fish twin of the bridge bash/zsh folder report (OSC 7 at every prompt, only inside WSL).
 * fish before 4 sends its own report only to a few named terminals, and none re-sends at a prompt
 * to undo a foreign one. `string escape --style=url` keeps the same unreserved set as bash/zsh.
 */
export const FISH_WSL_CWD_REPORT_FUNCTION = `function __orca_wsl_cwd_report --on-event fish_prompt
    test -n "$WSL_DISTRO_NAME"; or return 0
    if test "$PWD" != "$__orca_wsl_cwd_reported"
        set -g __orca_wsl_cwd_reported $PWD
        set -g __orca_wsl_cwd_encoded (string escape --style=url -- $PWD)
    end
    printf '\\e]7;file://%s\\a' "$__orca_wsl_cwd_encoded"
end
`

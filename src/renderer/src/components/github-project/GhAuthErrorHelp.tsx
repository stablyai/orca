/**
 * Inline guidance for `auth_required` / `scope_missing` errors from gh.
 *
 * Why: the canned remediation `gh auth refresh -s project ...` silently
 * no-ops when GITHUB_TOKEN/GH_TOKEN is exported in the user's shell — gh
 * prefers env tokens and refuses to refresh them. Users follow the
 * instructions, see no error, retry, and stay stuck. This component runs
 * a one-shot diagnostic and rewrites the suggested fix to match what gh
 * is actually doing: env-shadow vs. plain missing-scope vs. not-installed.
 */
import { useEffect, useState } from 'react'
import { Copy, ExternalLink, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { GitHubProjectViewError } from '@/../../shared/github-project-types'
import type { GhAuthDiagnostic } from '@/../../shared/github-auth-types'

type AuthErrorKind = 'auth_required' | 'scope_missing'

const REFRESH_CMD = 'gh auth refresh -s project -s read:org -s repo'
const LOGIN_CMD = 'gh auth login'

// AGENTS.md requires platform-specific shell guidance. The env-shadow
// remediation needs different commands per host shell — bash/zsh on
// macOS/Linux vs PowerShell on Windows.
const IS_WINDOWS = typeof navigator !== 'undefined' && /Win(dows|32|64)/i.test(navigator.userAgent)

function findEnvVarCommand(varName: string): { label: string; command: string } {
  if (IS_WINDOWS) {
    return {
      label: 'Check if it’s set (PowerShell)',
      command: `Get-ChildItem Env:${varName}`
    }
  }
  return {
    label: 'Find where it’s set',
    command: `grep -RIn '${varName}' ~/.zshrc ~/.zshenv ~/.bashrc ~/.bash_profile ~/.profile ~/.config 2>/dev/null`
  }
}

function unsetEnvVarCommand(varName: string): { label: string; command: string } {
  if (IS_WINDOWS) {
    // Persistent removal at the user scope; the user still needs a fresh
    // shell/Orca relaunch for the change to take effect.
    return {
      label: 'Unset (PowerShell, persistent)',
      command: `Remove-Item Env:${varName}; [Environment]::SetEnvironmentVariable('${varName}', $null, 'User')`
    }
  }
  return { label: 'Unset for this shell', command: `unset ${varName}` }
}

function openExternal(url: string): void {
  // In Electron renderers, raw `window.open` doesn't reliably route to the
  // user's default browser. Use the same shell IPC the rest of the app
  // uses (see SidebarToolbar.openExternalUrl).
  void window.api.shell.openUrl(url)
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success('Copied to clipboard')
  } catch {
    toast.error('Failed to copy')
  }
}

type Remediation = {
  /** Short human-readable summary of why the error is happening. */
  summary: string
  /** Optional follow-up paragraph explaining the fix. */
  detail?: string
  /** Commands to surface as copyable buttons, in order. */
  commands: { label: string; command: string }[]
  /** Optional external doc link. */
  docsUrl?: string
}

function buildRemediation(
  errorMessage: string,
  kind: AuthErrorKind,
  diag: GhAuthDiagnostic | null
): Remediation {
  // Diagnostic still loading or unavailable — fall back to the canned advice
  // so the UI never gets worse than the pre-diagnosis behavior.
  if (!diag) {
    return {
      summary: errorMessage,
      commands: [
        { label: 'Copy command', command: kind === 'auth_required' ? LOGIN_CMD : REFRESH_CMD }
      ]
    }
  }

  if (!diag.ghAvailable) {
    return {
      summary: 'GitHub CLI (`gh`) is not installed or not on PATH.',
      detail:
        'Orca uses `gh` to talk to GitHub Projects. Install it from cli.github.com, then sign in.',
      commands: [{ label: 'Copy login command', command: LOGIN_CMD }],
      docsUrl: 'https://cli.github.com/'
    }
  }

  const active = diag.activeAccount
  // Most insidious failure mode: gh is using a token from the environment,
  // so `gh auth refresh` prints "GITHUB_TOKEN is being used... first clear
  // the value from the environment" and exits 0 without doing anything.
  if (active?.envToken) {
    const varName = active.envToken
    const fallback = diag.hasKeyringFallback
      ? ' Your keyring already has a `gh` login that will take over once the env var is gone.'
      : ' After unsetting it, run `gh auth login` to sign in normally, then retry.'
    return {
      summary: `\`${varName}\` is set in your environment, so \`gh\` is using that token instead of your keyring login. \`gh auth refresh\` cannot modify env-supplied tokens — that's why running it didn't help.`,
      detail: IS_WINDOWS
        ? `Find where \`${varName}\` is set (System or User environment variables, or your PowerShell profile), remove it, then restart Orca so the new environment is picked up.${fallback}`
        : `Find where \`${varName}\` is exported (commonly \`~/.zshrc\`, \`~/.zshenv\`, \`~/.bashrc\`, \`~/.profile\`, or your shell's secrets manager), remove it, then restart Orca so the new environment is picked up.${fallback}`,
      commands: [findEnvVarCommand(varName), unsetEnvVarCommand(varName)],
      docsUrl: 'https://cli.github.com/manual/gh_help_environment'
    }
  }

  // gh is not the problem, but the Electron process inherited GITHUB_TOKEN
  // from the parent shell. Even after the user runs `gh auth refresh` in a
  // separate terminal, Orca's gh subprocess sees the env var and uses it.
  if (diag.envTokenInProcess && (!active || diag.missingScopes.length > 0)) {
    const varName = diag.envTokenInProcess
    return {
      summary: `Orca inherited \`${varName}\` from your shell, and \`gh\` is using that token. \`gh auth refresh\` doesn't apply to env-supplied tokens.`,
      detail: `Unset \`${varName}\` in the shell that launches Orca${
        IS_WINDOWS ? ' (or in your user environment variables)' : ' (or in your shell rc file)'
      }, then restart Orca.`,
      commands: [findEnvVarCommand(varName), unsetEnvVarCommand(varName)],
      docsUrl: 'https://cli.github.com/manual/gh_help_environment'
    }
  }

  if (kind === 'auth_required' || !active) {
    return {
      summary: 'You’re not signed in to GitHub via `gh`.',
      commands: [{ label: 'Copy login command', command: LOGIN_CMD }]
    }
  }

  // Plain missing-scope case on a keyring login — refresh will work.
  if (diag.missingScopes.length > 0) {
    return {
      summary: `Your \`gh\` token is missing the ${diag.missingScopes
        .map((s) => `\`${s}\``)
        .join(
          ', '
        )} scope${diag.missingScopes.length === 1 ? '' : 's'} needed for GitHub Projects.`,
      detail:
        'Run the refresh command in a terminal. It will open a browser to authorize the new scopes, then come back here and reload.',
      commands: [{ label: 'Copy refresh command', command: REFRESH_CMD }]
    }
  }

  // Scopes look fine but GitHub still rejected us — likely SAML SSO not
  // authorized for this org's token, or the project is in an org the token
  // can't see. Surface the most likely fix.
  return {
    summary: errorMessage,
    detail:
      'Your token has the required scopes but GitHub still denied access. If the project is in an org with SAML SSO, you must authorize this token for the org under Settings → Developer settings → Personal access tokens → Configure SSO.',
    commands: [{ label: 'Copy refresh command', command: REFRESH_CMD }],
    docsUrl:
      'https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-saml-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on'
  }
}

export function GhAuthErrorHelp({
  error,
  variant = 'block'
}: {
  error: GitHubProjectViewError & { type: AuthErrorKind }
  variant?: 'block' | 'banner'
}): React.JSX.Element {
  const [diag, setDiag] = useState<GhAuthDiagnostic | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.gh
      .diagnoseAuth()
      .then((d) => {
        if (!cancelled) {
          setDiag(d)
        }
      })
      // Diagnostic is best-effort; never block the error UI on it.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const remedy = buildRemediation(error.message, error.type, diag)
  const docsUrl = remedy.docsUrl

  if (variant === 'banner') {
    return (
      <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        <div className="font-medium">{remedy.summary}</div>
        {remedy.detail ? <div className="mt-0.5 opacity-80">{remedy.detail}</div> : null}
        <div className="mt-1 flex flex-wrap gap-1">
          {remedy.commands.map((c) => (
            <button
              key={c.command}
              type="button"
              onClick={() => copyToClipboard(c.command)}
              title={c.command}
              className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
            >
              <Copy className="size-3" /> {c.label}
            </button>
          ))}
          {docsUrl ? (
            <button
              type="button"
              onClick={() => openExternal(docsUrl)}
              className="inline-flex items-center gap-1 rounded border border-amber-500/30 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
            >
              <ExternalLink className="size-3" /> Docs
            </button>
          ) : null}
          {/* Why: after running the refresh command in a terminal, users need to
              reload the renderer to pick up the new gh token state. */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-1 rounded border border-amber-500/30 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
          >
            <RotateCw className="size-3" /> Reload
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="text-foreground">{remedy.summary}</div>
      {remedy.detail ? <div className="text-muted-foreground">{remedy.detail}</div> : null}
      <div className="flex flex-wrap gap-2">
        {remedy.commands.map((c) => (
          <Button
            key={c.command}
            size="sm"
            variant="outline"
            title={c.command}
            onClick={() => copyToClipboard(c.command)}
          >
            <Copy className="mr-1 size-3.5" /> {c.label}
          </Button>
        ))}
        {docsUrl ? (
          <Button size="sm" variant="outline" onClick={() => openExternal(docsUrl)}>
            <ExternalLink className="mr-1 size-3.5" /> Docs
          </Button>
        ) : null}
        {/* Why: after running the refresh command in a terminal, users need to
            reload the renderer to pick up the new gh token state. */}
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          <RotateCw className="mr-1 size-3.5" /> Reload
        </Button>
      </div>
    </div>
  )
}

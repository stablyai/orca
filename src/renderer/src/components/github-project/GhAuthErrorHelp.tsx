/** Diagnose gh auth failures because environment tokens override keyring credentials and make auth refresh ineffective. */
import { useEffect, useState } from 'react'
import { Copy, ExternalLink, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'
import type { GhAuthDiagnostic } from '../../../../shared/github/auth-types'
import { translate } from '@/i18n/i18n'
import { projectViewErrorMessage } from './project-view-error-copy'
import { openAppHttpLink } from '@/lib/app-http-link-open'

type AuthErrorKind = 'auth_required' | 'scope_missing'

const REFRESH_CMD = 'gh auth refresh -s project -s read:org -s repo'
const LOGIN_CMD = 'gh auth login'

// Scope login to the Enterprise host; signing in to github.com cannot repair GHES credentials.
function loginCommandForHost(host: string | null | undefined): string {
  return host && host.toLowerCase() !== 'github.com'
    ? `gh auth login --hostname ${host}`
    : LOGIN_CMD
}

function refreshCommandForHost(host: string | null | undefined): string {
  return host && host.toLowerCase() !== 'github.com'
    ? `gh auth refresh --hostname ${host} -s project -s read:org -s repo`
    : REFRESH_CMD
}

// Environment cleanup commands differ between PowerShell on Windows and bash/zsh on macOS/Linux.
const IS_WINDOWS = typeof navigator !== 'undefined' && /Win(dows|32|64)/i.test(navigator.userAgent)

export function reloadOrcaRenderer(): void {
  void window.api.app.reload().catch((error) => {
    console.error(
      '[github-projects] Renderer reload refused:',
      error instanceof Error ? error.name : typeof error
    )
  })
}

function findEnvVarCommand(varName: string): { label: string; command: string } {
  if (IS_WINDOWS) {
    return {
      label: translate(
        'auto.components.github.project.GhAuthErrorHelp.df636f5886',
        'Check if it’s set (PowerShell)'
      ),
      command: `Get-ChildItem Env:${varName}`
    }
  }
  return {
    label: translate(
      'auto.components.github.project.GhAuthErrorHelp.ae43542893',
      'Find where it’s set'
    ),
    command: `grep -RIn '${varName}' ~/.zshrc ~/.zshenv ~/.bashrc ~/.bash_profile ~/.profile ~/.config 2>/dev/null`
  }
}

function unsetEnvVarCommand(varName: string): { label: string; command: string } {
  if (IS_WINDOWS) {
    // User-scope changes require a fresh shell and Orca relaunch.
    return {
      label: translate(
        'auto.components.github.project.GhAuthErrorHelp.fd17b3019f',
        'Unset (PowerShell, persistent)'
      ),
      command: `Remove-Item Env:${varName}; [Environment]::SetEnvironmentVariable('${varName}', $null, 'User')`
    }
  }
  return {
    label: translate(
      'auto.components.github.project.GhAuthErrorHelp.891a7d4616',
      'Unset for this shell'
    ),
    command: `unset ${varName}`
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.github.project.GhAuthErrorHelp.224c9d0ae8', 'Copied to clipboard')
    )
  } catch {
    toast.error(
      translate('auto.components.github.project.GhAuthErrorHelp.8a7f6bf5dc', 'Failed to copy')
    )
  }
}

type Remediation = {
  summary: string
  detail?: string
  commands: { label: string; command: string }[]
  docsUrl?: string
}

export function buildRemediation(
  errorMessage: string,
  kind: AuthErrorKind,
  diag: GhAuthDiagnostic | null,
  requestedHost?: string
): Remediation {
  // Keep the original guidance usable while diagnosis loads or is unavailable.
  if (!diag) {
    return {
      summary: errorMessage,
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.b436c586d1',
            'Copy command'
          ),
          command:
            kind === 'auth_required'
              ? loginCommandForHost(requestedHost)
              : refreshCommandForHost(requestedHost)
        }
      ]
    }
  }

  // Missing Enterprise credentials outrank token/scope advice for another host.
  if (diag.requiredHost && diag.requiredHostAuthenticated === false) {
    return {
      summary: translate(
        'projectViews.authHelp.hostSignedOut',
        '`gh` is not signed in to {{host}}.',
        { host: diag.requiredHost }
      ),
      detail: translate(
        'projectViews.authHelp.hostSignedOutDetail',
        'GitHub Enterprise hosts need their own `gh` login, separate from github.com. Run the login command in a terminal, complete the browser flow on {{host}}, then reload.',
        { host: diag.requiredHost }
      ),
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.9c2da6353b',
            'Copy login command'
          ),
          command: loginCommandForHost(diag.requiredHost)
        }
      ]
    }
  }

  if (!diag.ghAvailable) {
    return {
      summary: translate(
        'projectViews.authHelp.ghMissing',
        'GitHub CLI (`gh`) is not installed or not on PATH.'
      ),
      detail: translate(
        'projectViews.authHelp.ghMissingDetail',
        'Orca uses `gh` to talk to GitHub Projects. Install it from cli.github.com, then sign in.'
      ),
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.9c2da6353b',
            'Copy login command'
          ),
          command: loginCommandForHost(diag.requiredHost ?? requestedHost)
        }
      ],
      docsUrl: 'https://cli.github.com/'
    }
  }

  const active = diag.activeAccount
  // gh auth refresh can exit successfully without changing an environment-supplied token.
  if (active?.envToken) {
    const varName = active.envToken
    const fallback = diag.hasKeyringFallback
      ? translate(
          'projectViews.authHelp.envTokenKeyringFallback',
          'Your keyring already has a `gh` login that will take over once the env var is gone.'
        )
      : translate(
          'projectViews.authHelp.envTokenLoginAfterUnset',
          'After unsetting it, run `gh auth login` to sign in normally, then retry.'
        )
    const removal = IS_WINDOWS
      ? translate(
          'projectViews.authHelp.envTokenRemoveWindows',
          'Find where `{{varName}}` is set (System or User environment variables, or your PowerShell profile), remove it, then restart Orca so the new environment is picked up.',
          { varName }
        )
      : translate(
          'projectViews.authHelp.envTokenRemovePosix',
          "Find where `{{varName}}` is exported (commonly `~/.zshrc`, `~/.zshenv`, `~/.bashrc`, `~/.profile`, or your shell's secrets manager), remove it, then restart Orca so the new environment is picked up.",
          { varName }
        )
    return {
      summary: translate(
        'projectViews.authHelp.envTokenActive',
        "`{{varName}}` is set in your environment, so `gh` is using that token instead of your keyring login. `gh auth refresh` cannot modify env-supplied tokens — that's why running it didn't help.",
        { varName }
      ),
      detail: `${removal} ${fallback}`,
      commands: [findEnvVarCommand(varName), unsetEnvVarCommand(varName)],
      docsUrl: 'https://cli.github.com/manual/gh_help_environment'
    }
  }

  // Orca’s inherited token can still shadow credentials refreshed in a separate terminal.
  if (diag.envTokenInProcess && (!active || diag.missingScopes.length > 0)) {
    const varName = diag.envTokenInProcess
    return {
      summary: translate(
        'projectViews.authHelp.envTokenInherited',
        "Orca inherited `{{varName}}` from your shell, and `gh` is using that token. `gh auth refresh` doesn't apply to env-supplied tokens.",
        { varName }
      ),
      detail: IS_WINDOWS
        ? translate(
            'projectViews.authHelp.envTokenInheritedDetailWindows',
            'Unset `{{varName}}` in the shell that launches Orca (or in your user environment variables), then restart Orca.',
            { varName }
          )
        : translate(
            'projectViews.authHelp.envTokenInheritedDetailPosix',
            'Unset `{{varName}}` in the shell that launches Orca (or in your shell rc file), then restart Orca.',
            { varName }
          ),
      commands: [findEnvVarCommand(varName), unsetEnvVarCommand(varName)],
      docsUrl: 'https://cli.github.com/manual/gh_help_environment'
    }
  }

  if (kind === 'auth_required' || !active) {
    return {
      summary: translate(
        'projectViews.authHelp.signedOut',
        'You’re not signed in to GitHub via `gh`.'
      ),
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.9c2da6353b',
            'Copy login command'
          ),
          command: loginCommandForHost(diag.requiredHost)
        }
      ]
    }
  }

  if (diag.missingScopes.length > 0) {
    return {
      summary: translate(
        'projectViews.authHelp.missingScopes',
        'Your `gh` token is missing scopes needed for GitHub Projects: {{scopes}}.',
        { scopes: diag.missingScopes.map((scope) => `\`${scope}\``).join(', ') }
      ),
      detail: translate(
        'projectViews.authHelp.missingScopesDetail',
        'Run the refresh command in a terminal. It will open a browser to authorize the new scopes, then come back here and reload.'
      ),
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.3fefeebde4',
            'Copy refresh command'
          ),
          command: refreshCommandForHost(diag.requiredHost)
        }
      ]
    }
  }

  // Valid scopes can still fail on org visibility or SAML SSO authorization.
  return {
    summary: errorMessage,
    detail: translate(
      'projectViews.authHelp.accessDeniedDetail',
      'Your token has the required scopes but GitHub still denied access. If the project is in an org with SAML SSO, you must authorize this token for the org under Settings → Developer settings → Personal access tokens → Configure SSO.'
    ),
    commands: [
      {
        label: translate(
          'auto.components.github.project.GhAuthErrorHelp.3fefeebde4',
          'Copy refresh command'
        ),
        command: refreshCommandForHost(diag.requiredHost ?? requestedHost)
      }
    ],
    docsUrl:
      'https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-saml-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on'
  }
}

export function GhAuthErrorHelp({
  error,
  variant = 'block',
  host
}: {
  error: GitHubProjectViewError & { type: AuthErrorKind }
  variant?: 'block' | 'banner'
  /** GHES host the failing surface talks to; scopes the diagnosis per host. */
  host?: string
}): React.JSX.Element {
  const [diag, setDiag] = useState<GhAuthDiagnostic | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.gh
      .diagnoseAuth(host ? { host } : undefined)
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
  }, [host])

  const remedy = buildRemediation(projectViewErrorMessage(error, { host }), error.type, diag, host)
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
              onClick={(event) => openAppHttpLink(docsUrl, { event })}
              className="inline-flex items-center gap-1 rounded border border-amber-500/30 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
            >
              <ExternalLink className="size-3" />{' '}
              {translate('auto.components.github.project.GhAuthErrorHelp.baa006f9af', 'Docs')}
            </button>
          ) : null}
          {/* Reload diagnostics after refreshing credentials in a terminal. */}
          <button
            type="button"
            onClick={reloadOrcaRenderer}
            className="inline-flex items-center gap-1 rounded border border-amber-500/30 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
          >
            <RotateCw className="size-3" />{' '}
            {translate('auto.components.github.project.GhAuthErrorHelp.7e800068d8', 'Reload')}
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
          <Button
            size="sm"
            variant="outline"
            onClick={(event) => openAppHttpLink(docsUrl, { event })}
          >
            <ExternalLink className="mr-1 size-3.5" />{' '}
            {translate('auto.components.github.project.GhAuthErrorHelp.baa006f9af', 'Docs')}
          </Button>
        ) : null}
        {/* Reload diagnostics after refreshing credentials in a terminal. */}
        <Button size="sm" variant="outline" onClick={reloadOrcaRenderer}>
          <RotateCw className="mr-1 size-3.5" />{' '}
          {translate('auto.components.github.project.GhAuthErrorHelp.7e800068d8', 'Reload')}
        </Button>
      </div>
    </div>
  )
}

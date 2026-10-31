import { stripCredentialsFromMessage } from '../../git-remote-error'
import { parseGitRepositoryIdentity } from '../catalog/plugin-marketplace'

export const GIT_AUTH_FAILED_CODE = 'git_auth_failed'

export type PluginGitAccessFailure = {
  url: string
  transport: 'https' | 'ssh'
  /** The Git server, e.g. github.com. */
  gitHost: string | null
  /** The machine whose Git ran, named so the fix happens there. */
  executionHost: string
  detail: string
  nextSteps: string[]
}

// Why "not found" counts: GitHub and GitLab answer a private repository without access as missing.
const ACCESS_PATTERNS = [
  /could not read (Username|Password)/i,
  /terminal prompts disabled/i,
  /Authentication failed/i,
  /HTTP Basic: Access denied/i,
  /Invalid username or password/i,
  /unable to get password/i,
  /The requested URL returned error: 40[134]/i,
  /Permission denied \(publickey/i,
  /Host key verification failed/i,
  /Could not read from remote repository/i,
  /Repository not found/i,
  /repository '[^']*' not found/i,
  /The project you were looking for could not be found/i
]

export function pluginGitTransport(url: string): 'https' | 'ssh' {
  return url.startsWith('https://') ? 'https' : 'ssh'
}

function credentialSetupStep(gitHost: string | null, on: string): string {
  if (gitHost === 'github.com') {
    return `On ${on}, sign Git in to GitHub without a prompt: \`gh auth login\` then \`gh auth setup-git\` (or any Git credential helper).`
  }
  if (gitHost === 'gitlab.com') {
    return `On ${on}, sign Git in to GitLab without a prompt: \`glab auth login\` and let it set up Git credentials (or any Git credential helper).`
  }
  return `On ${on}, set up a Git credential helper (Git Credential Manager, osxkeychain or libsecret) that can read this repository without a prompt.`
}

/**
 * A Git download that failed because this host's Git could not authenticate, or null for any other
 * failure. Git runs without prompts, so a private repository needs credentials already set up.
 */
export function classifyPluginGitAccessFailure(input: {
  error: string
  url: string
  executionHost: string
}): PluginGitAccessFailure | null {
  const detail = stripCredentialsFromMessage(input.error).trim()
  if (!ACCESS_PATTERNS.some((pattern) => pattern.test(detail))) {
    return null
  }
  const transport = pluginGitTransport(input.url)
  const identity = parseGitRepositoryIdentity(input.url)
  const gitHost = identity?.host ?? null
  const on = input.executionHost
  const nextSteps =
    transport === 'https'
      ? [
          credentialSetupStep(gitHost, on),
          identity
            ? `Or use SSH if ${on} has a key for ${gitHost}: git@${gitHost}:${identity.path}.git`
            : 'Or use the SSH URL of the repository if that host has an SSH key for it.'
        ]
      : [
          `On ${on}, load an SSH key that can read this repository into ssh-agent and make sure \`ssh -T git@${gitHost ?? '<host>'}\` connects without a prompt (the host key must already be in known_hosts).`,
          identity
            ? `Or use HTTPS with a Git credential helper: https://${gitHost}/${identity.path}`
            : 'Or use the HTTPS URL with a Git credential helper.'
        ]
  nextSteps.push(
    `Check with \`git ls-remote ${input.url}\` on ${on}; it must work without asking for a password.`,
    'Never put a token or password in the URL; Orca refuses URLs that carry credentials.'
  )
  return { url: input.url, transport, gitHost, executionHost: on, detail, nextSteps }
}

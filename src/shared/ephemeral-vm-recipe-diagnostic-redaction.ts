import { stripCredentialsFromMessage } from './git/remotes/git-remote-error'

// Kept apart from the result diagnostics so browser bundles can redact without the pairing codec.
export function redactEphemeralVmRecipeDiagnosticText(text: string): string {
  if (!text) {
    return text
  }
  return stripCredentialsFromMessage(text)
    .replace(/orca:\/\/pair\?code=[A-Za-z0-9_-]+/g, 'orca://pair?code=[redacted]')
    .replace(
      /("(?:pairingCode|deviceToken|publicKeyB64|token|secret|password|apiKey|accessToken|identityFile|identityAgent|proxyCommand)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"'
    )
}

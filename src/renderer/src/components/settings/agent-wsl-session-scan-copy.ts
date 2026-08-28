import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getAgentWslSessionScanTitle(): string {
  return translate(
    'auto.components.settings.agentWslSessionScan.title',
    'Scan WSL for agent sessions'
  )
}

export function getAgentWslSessionScanDescription(): string {
  return translate(
    'auto.components.settings.agentWslSessionScan.description',
    'Include WSL distros in Agent Session History. Each scan boots every stopped distro to find its home directory; turn off to keep WSL idle. Off also hides WSL sessions from history, delete, and live Codex chat.'
  )
}

export function getAgentWslSessionScanSearchKeywords(): string[] {
  return [
    ...translateSearchKeyword('auto.components.settings.agentWslSessionScan.wsl', 'wsl'),
    ...translateSearchKeyword('auto.components.settings.agentWslSessionScan.distro', 'distro'),
    ...translateSearchKeyword('auto.components.settings.agentWslSessionScan.vmmem', 'vmmem'),
    ...translateSearchKeyword('auto.components.settings.agentWslSessionScan.memory', 'memory'),
    ...translateSearchKeyword(
      'auto.components.settings.agentWslSessionScan.sessionHistory',
      'session history'
    ),
    ...translateSearchKeyword('auto.components.settings.agentWslSessionScan.aiVault', 'ai vault'),
    ...translateSearchKeyword(
      'auto.components.settings.agentWslSessionScan.transcripts',
      'transcripts'
    )
  ]
}

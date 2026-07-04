// The per-agent slash-command catalog now lives in src/shared so the desktop
// renderer and the mobile app share one source of truth (no drift). This file
// re-exports it for existing desktop import sites.

export {
  getAgentSlashCommands,
  type SlashCommandSuggestion
} from '../../../../shared/native-chat-slash-commands'

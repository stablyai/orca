import type { GlobalSettings, NotificationSettings, PersistedState, PersistedUIState, RepoHookSettings, StatusBarItem, WorkspaceSessionState, WorktreeCardProperty } from './types';
export declare const SCHEMA_VERSION = 1;
export declare const ORCA_BROWSER_PARTITION = "persist:orca-browser";
export declare const ORCA_BROWSER_BLANK_URL = "data:text/html,";
/**
 * Why: ProseMirror builds an in-memory tree for the entire document, so large
 * markdown files cause noticeable typing lag in the rich editor. Files above
 * this threshold fall back to source mode (Monaco) which handles large files
 * efficiently via virtualized line rendering.
 */
export declare const RICH_MARKDOWN_MAX_SIZE_BYTES: number;
export declare const DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS = 1000;
export declare const MIN_EDITOR_AUTO_SAVE_DELAY_MS = 250;
export declare const MAX_EDITOR_AUTO_SAVE_DELAY_MS = 10000;
export declare const DEFAULT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[];
export declare const DEFAULT_STATUS_BAR_ITEMS: StatusBarItem[];
export declare const REPO_COLORS: readonly ["#737373", "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#8b5cf6", "#ec4899"];
export declare function getDefaultNotificationSettings(): NotificationSettings;
export declare function getDefaultSettings(homedir: string): GlobalSettings;
export declare function getDefaultRepoHookSettings(): RepoHookSettings;
export declare function getDefaultPersistedState(homedir: string): PersistedState;
export declare function getDefaultUIState(): PersistedUIState;
export declare function getDefaultWorkspaceSession(): WorkspaceSessionState;

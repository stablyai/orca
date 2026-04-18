/**
 * Shared agent detection utilities — used by both the main process (stats
 * collection) and the renderer (activity indicators, unread badges).
 *
 * Why shared: the main process needs the same OSC title extraction and agent
 * status detection for stat tracking that the renderer uses for UI indicators.
 * Duplicating this logic would risk drift between the two detection paths.
 */
export type AgentStatus = 'working' | 'permission' | 'idle';
export declare const AGENT_NAMES: string[];
/**
 * Extract the last OSC title-set sequence from raw PTY data.
 * Agent CLIs (Claude Code, Gemini, etc.) set OSC titles to announce their
 * identity and status. This is a single regex scan — comparable cost to one
 * normalizeTerminalChunk pass.
 */
export declare function extractLastOscTitle(data: string): string | null;
export declare function isGeminiTerminalTitle(title: string): boolean;
export declare function isPiTerminalTitle(title: string): boolean;
/**
 * Strip working-status indicators from a title so that
 * `detectAgentStatusFromTitle` will no longer return 'working'.
 * Used to clear stale titles when an agent exits without resetting its title.
 */
export declare function clearWorkingIndicators(title: string): string;
/**
 * Tracks agent status transitions from terminal title changes.
 * Fires `onBecameIdle` when an agent transitions from working to idle/permission,
 * like haunt's attention flag — the key trigger for unread notifications.
 */
export declare function createAgentStatusTracker(onBecameIdle: (title: string) => void, onBecameWorking?: () => void, onAgentExited?: () => void): {
    handleTitle: (title: string) => void;
    /** Clear accumulated status so a stale working→idle transition cannot fire
     *  after the owning transport is torn down. */
    reset: () => void;
};
/**
 * Normalize high-churn agent titles into stable display labels before storing
 * them in app state. Gemini CLI can emit per-keystroke title updates, which
 * otherwise causes broad rerenders and visible flashing.
 */
export declare function normalizeTerminalTitle(title: string): string;
/**
 * Returns true when the terminal title matches Claude Code's title conventions.
 * Used to scope prompt-cache-timer behavior to Claude sessions only — other
 * agents have different (or no) caching semantics.
 */
export declare function isClaudeAgent(title: string): boolean;
export declare function getAgentLabel(title: string): string | null;
export declare function detectAgentStatusFromTitle(title: string): AgentStatus | null;

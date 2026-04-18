import type { AgentStartupPlan } from '@/lib/tui-agent-startup';
import type { GitHubWorkItem, OrcaHooks, TaskViewPresetId } from '../../../shared/types';
/**
 * Why: the NewWorkspacePage's preset buttons and the openNewWorkspacePage
 * prefetcher both need to compute the same GitHub query string for a given
 * preset id. Keep the mapping here so the prefetch warms exactly the cache
 * key the page will look up on mount.
 */
export declare function getTaskPresetQuery(presetId: TaskViewPresetId | null): string;
export declare const IS_MAC: boolean;
export declare const ADD_ATTACHMENT_SHORTCUT: string;
export declare const CLIENT_PLATFORM: NodeJS.Platform;
export type LinkedWorkItemSummary = {
    type: 'issue' | 'pr';
    number: number;
    title: string;
    url: string;
};
export declare const DEFAULT_ISSUE_COMMAND_TEMPLATE = "Complete {{artifact_url}}";
/**
 * Substitute the issue-command template variables. Prefers `{{artifact_url}}`
 * and keeps `{{issue}}` working silently for repos that have not migrated
 * their `orca.yaml` / `.orca/issue-command` yet.
 */
export declare function renderIssueCommandTemplate(template: string, vars: {
    issueNumber: number | null;
    artifactUrl: string | null;
}): string;
export declare function buildAgentPromptWithContext(prompt: string, attachments: string[], linkedUrls: string[]): string;
export declare function getAttachmentLabel(pathValue: string): string;
export declare function getSetupConfig(repo: {
    hookSettings?: {
        scripts?: {
            setup?: string;
        };
    };
} | undefined, yamlHooks: OrcaHooks | null): {
    source: 'yaml' | 'legacy';
    command: string;
} | null;
export declare function getLinkedWorkItemSuggestedName(item: GitHubWorkItem): string;
export declare function getWorkspaceSeedName(args: {
    explicitName: string;
    prompt: string;
    linkedIssueNumber: number | null;
    linkedPR: number | null;
}): string;
export declare function ensureAgentStartupInTerminal(args: {
    worktreeId: string;
    startup: AgentStartupPlan;
}): Promise<void>;

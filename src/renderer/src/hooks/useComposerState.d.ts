import { useAppStore } from '@/store';
import type { GitHubWorkItem, TuiAgent } from '../../../shared/types';
import { type LinkedWorkItemSummary } from '@/lib/new-workspace';
export type UseComposerStateOptions = {
    initialRepoId?: string;
    initialName?: string;
    initialPrompt?: string;
    initialLinkedWorkItem?: LinkedWorkItemSummary | null;
    /** Why: the full-page composer persists drafts so users can navigate away
     *  without losing work; the quick-composer modal is transient and must not
     *  clobber or leak that long-running draft. */
    persistDraft: boolean;
    /** Invoked after a successful createWorktree. The caller usually closes its
     *  surface here (palette modal, full page, etc.). */
    onCreated?: () => void;
    /** Optional external repoId override — used by NewWorkspacePage's task list
     *  which wants to drive repo selection from the page header, not the card. */
    repoIdOverride?: string;
    onRepoIdOverrideChange?: (value: string) => void;
};
export type ComposerCardProps = {
    eligibleRepos: ReturnType<typeof useAppStore.getState>['repos'];
    repoId: string;
    onRepoChange: (value: string) => void;
    name: string;
    onNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    agentPrompt: string;
    onAgentPromptChange: (value: string) => void;
    onPromptKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    /** Rendered issueCommand template to preview inside the empty prompt
     *  textarea when the user has linked a work item but not typed anything. */
    linkedOnlyTemplatePreview: string | null;
    attachmentPaths: string[];
    getAttachmentLabel: (pathValue: string) => string;
    onAddAttachment: () => void;
    onRemoveAttachment: (pathValue: string) => void;
    addAttachmentShortcut: string;
    linkedWorkItem: LinkedWorkItemSummary | null;
    onRemoveLinkedWorkItem: () => void;
    linkPopoverOpen: boolean;
    onLinkPopoverOpenChange: (open: boolean) => void;
    linkQuery: string;
    onLinkQueryChange: (value: string) => void;
    filteredLinkItems: GitHubWorkItem[];
    linkItemsLoading: boolean;
    linkDirectLoading: boolean;
    normalizedLinkQuery: {
        query: string;
        repoMismatch: string | null;
    };
    onSelectLinkedItem: (item: GitHubWorkItem) => void;
    tuiAgent: TuiAgent;
    onTuiAgentChange: (value: TuiAgent) => void;
    detectedAgentIds: Set<TuiAgent> | null;
    onOpenAgentSettings: () => void;
    advancedOpen: boolean;
    onToggleAdvanced: () => void;
    createDisabled: boolean;
    creating: boolean;
    onCreate: () => void;
    note: string;
    onNoteChange: (value: string) => void;
    setupConfig: {
        source: 'yaml' | 'legacy';
        command: string;
    } | null;
    requiresExplicitSetupChoice: boolean;
    setupDecision: 'run' | 'skip' | null;
    onSetupDecisionChange: (value: 'run' | 'skip') => void;
    shouldWaitForSetupCheck: boolean;
    resolvedSetupDecision: 'run' | 'skip' | null;
    createError: string | null;
};
export type UseComposerStateResult = {
    cardProps: ComposerCardProps;
    /** Ref the consumer should attach to the composer wrapper so the global
     *  Enter-to-submit handler can scope its behavior to the visible composer. */
    composerRef: React.RefObject<HTMLDivElement | null>;
    promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
    nameInputRef: React.RefObject<HTMLInputElement | null>;
    submit: () => Promise<void>;
    /** Invoked by the Enter handler to re-check whether submission should fire. */
    createDisabled: boolean;
};
export declare function useComposerState(options: UseComposerStateOptions): UseComposerStateResult;

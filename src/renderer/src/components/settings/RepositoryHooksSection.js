import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: the YAML status card, issue-command editor, policy grid, and legacy-hook section form one cohesive settings surface; splitting them across files would scatter tightly coupled state and prop drilling. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { SearchableSetting } from './SearchableSetting';
const SETUP_RUN_POLICY_OPTIONS = [
    { policy: 'ask', label: 'Ask every time', description: 'Prompt before running setup.' },
    { policy: 'run-by-default', label: 'Run by default', description: 'Run setup automatically.' },
    {
        policy: 'skip-by-default',
        label: 'Skip by default',
        description: 'Only run setup when chosen.'
    }
];
const EXAMPLE_TEMPLATE = `scripts:
  setup: |
    pnpm worktree:setup
  archive: |
    echo "Cleaning up before archive"
issueCommand: |
  Complete {{artifact_url}}`;
const YAML_STATE_STYLES = {
    loaded: {
        card: 'border-emerald-500/20 bg-emerald-500/5',
        title: 'text-emerald-700 dark:text-emerald-300',
        heading: 'Using `orca.yaml`',
        description: 'Shared hook and issue-automation defaults are defined in the repo and available to everyone who uses it.'
    },
    'update-available': {
        card: 'border-amber-500/20 bg-amber-500/5',
        title: 'text-amber-700 dark:text-amber-300',
        heading: '`orca.yaml` could not be parsed',
        description: 'The file contains configuration keys that this version of Orca does not recognize. You may need to update Orca, or check the file for typos.'
    },
    invalid: {
        card: 'border-amber-500/20 bg-amber-500/5',
        title: 'text-amber-700 dark:text-amber-300',
        heading: '`orca.yaml` could not be parsed',
        description: 'The core configuration file exists in the repo root, but Orca could not parse the supported hook definitions yet.'
    },
    missing: {
        card: 'border-border/50 bg-muted/20',
        title: 'text-foreground',
        heading: 'No `orca.yaml` detected',
        description: 'Add an `orca.yaml` file to enable shared setup, archive, or issue-automation defaults for this repo. Example template:'
    }
};
/** Shared button grid for setup run-policy selectors. */
function PolicyOptionGrid({ options, selected, onSelect, columns }) {
    return (_jsx("div", { className: `grid gap-2 ${columns}`, children: options.map(({ policy, label, description }) => {
            const active = selected === policy;
            return (_jsxs("button", { onClick: () => onSelect(policy), className: `rounded-xl border px-3 py-2.5 text-center transition-colors ${active
                    ? 'border-foreground/15 bg-accent text-accent-foreground'
                    : 'border-border/60 bg-background text-foreground hover:border-border hover:bg-muted/40'}`, children: [_jsx("span", { className: `block text-sm ${active ? 'font-semibold' : 'font-medium'}`, children: label }), _jsx("p", { className: `mt-1 text-[11px] leading-4 ${active ? 'text-accent-foreground/80' : 'text-muted-foreground'}`, children: description })] }, policy));
        }) }));
}
function ExampleTemplateCard({ copiedTemplate, onCopyTemplate }) {
    return (_jsxs("div", { className: "space-y-2", children: [_jsxs("p", { className: "text-[10px] tracking-[0.18em] text-muted-foreground", children: ["Example ", _jsx("code", { className: "rounded bg-muted px-1 py-0.5", children: "orca.yaml" }), " template"] }), _jsxs("div", { className: "relative rounded-lg border border-border/50 bg-background/70", children: [_jsx(Button, { type: "button", variant: copiedTemplate ? 'secondary' : 'ghost', size: "sm", className: `absolute right-2 top-2 z-10 h-6 px-2 text-[11px] ${copiedTemplate ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`, onClick: onCopyTemplate, children: copiedTemplate ? 'Copied' : 'Copy' }), _jsx("pre", { className: "overflow-x-auto whitespace-pre-wrap break-words p-3 pr-16 font-mono text-[11px] leading-5 text-muted-foreground", children: EXAMPLE_TEMPLATE })] })] }));
}
export function RepositoryHooksSection({ repo, yamlHooks, hasHooksFile, mayNeedUpdate, copiedTemplate, onCopyTemplate, onClearLegacyHooks, onUpdateSetupRunPolicy }) {
    // Why: distinguish "file has unrecognised top-level keys" from "file is
    // genuinely malformed" so users see a helpful update prompt instead of a
    // confusing parse-error when a newer Orca version adds keys to `orca.yaml`.
    const yamlState = yamlHooks
        ? 'loaded'
        : hasHooksFile
            ? mayNeedUpdate
                ? 'update-available'
                : 'invalid'
            : 'missing';
    const hs = repo.hookSettings;
    const legacyHookEntries = ['setup', 'archive']
        .map((hookName) => [hookName, hs?.scripts[hookName]?.trim() ?? ''])
        .filter(([, script]) => Boolean(script));
    // Why: the type allows `undefined` in persisted settings for backward compatibility,
    // but the UI always needs a concrete value so the policy grid has an active selection.
    const selectedSetupRunPolicy = hs?.setupRunPolicy ?? 'run-by-default';
    const [issueCommandDraft, setIssueCommandDraft] = useState('');
    const [hasSharedIssueCommand, setHasSharedIssueCommand] = useState(false);
    const [issueCommandSaveError, setIssueCommandSaveError] = useState(null);
    // Why: track the latest draft across blur/unmount so repo switches still
    // persist the user's local override without racing the next repo's state load.
    const issueCommandDraftRef = useRef(issueCommandDraft);
    issueCommandDraftRef.current = issueCommandDraft;
    const lastCommittedIssueCommandRef = useRef('');
    // Keep the local override editor in sync with the selected repo and flush unsaved edits on exit.
    useEffect(() => {
        let cancelled = false;
        const repoId = repo.id;
        setIssueCommandDraft('');
        setHasSharedIssueCommand(false);
        setIssueCommandSaveError(null);
        // Why: settings only edit the local override, but we still need to know
        // whether `orca.yaml` defines a shared default so the helper copy can
        // explain what happens when the override is blank.
        void window.api.hooks
            .readIssueCommand({ repoId })
            .then((result) => {
            if (cancelled) {
                return;
            }
            const localContent = result.localContent ?? '';
            setIssueCommandDraft(localContent);
            setHasSharedIssueCommand(Boolean(result.sharedContent));
            lastCommittedIssueCommandRef.current = localContent;
        })
            .catch(() => {
            if (!cancelled) {
                setIssueCommandDraft('');
                setHasSharedIssueCommand(false);
                lastCommittedIssueCommandRef.current = '';
            }
        });
        return () => {
            cancelled = true;
            const draft = issueCommandDraftRef.current.trim();
            if (draft !== lastCommittedIssueCommandRef.current) {
                void window.api.hooks.writeIssueCommand({ repoId, content: draft }).catch((err) => {
                    console.error('[RepositoryHooksSection] Failed to save issue command on unmount:', err);
                });
            }
        };
    }, [repo.id]);
    const commitIssueCommand = useCallback(async () => {
        const trimmed = issueCommandDraft.trim();
        setIssueCommandDraft(trimmed);
        try {
            await window.api.hooks.writeIssueCommand({ repoId: repo.id, content: trimmed });
            lastCommittedIssueCommandRef.current = trimmed;
            setIssueCommandSaveError(null);
        }
        catch (err) {
            console.error('[RepositoryHooksSection] Failed to write issue command:', err);
            const message = err instanceof Error ? err.message : 'Failed to save GitHub issue command.';
            setIssueCommandSaveError(message);
            toast.error(message);
        }
    }, [issueCommandDraft, repo.id]);
    return (_jsxs("section", { className: "space-y-6", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Worktree Hooks" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Orca prefers shared hooks from `orca.yaml` and still honors older repo-local hook scripts until you clear them." })] }), _jsx(SearchableSetting, { title: "orca.yaml hooks", description: "Shared setup, archive, and issue automation commands for this repository.", keywords: ['hooks', 'setup', 'archive', 'yaml'], children: _jsxs("div", { className: `space-y-3 rounded-xl border p-4 ${YAML_STATE_STYLES[yamlState].card}`, children: [_jsxs("div", { className: "space-y-1", children: [_jsx("p", { className: `text-sm font-medium ${YAML_STATE_STYLES[yamlState].title}`, children: YAML_STATE_STYLES[yamlState].heading }), _jsx("p", { className: "text-xs text-muted-foreground", children: YAML_STATE_STYLES[yamlState].description })] }), yamlState === 'loaded' ? (_jsxs("div", { className: "space-y-2", children: [_jsx("div", { className: "rounded-lg border border-border/50 bg-background/70", children: _jsx("pre", { className: "overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-foreground", children: renderYamlScriptPreview(yamlHooks) }) }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Edit `orca.yaml` in the repository if you need to change these shared commands." })] })) : yamlState === 'update-available' ? (_jsx(ExampleTemplateCard, { copiedTemplate: copiedTemplate, onCopyTemplate: onCopyTemplate })) : yamlState === 'invalid' ? (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-start gap-3 rounded-xl border border-amber-500/20 bg-background/60 p-4", children: [_jsx("div", { className: "flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-300", children: _jsx(AlertTriangle, { className: "size-5" }) }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx("p", { className: "text-base font-semibold text-amber-900 dark:text-amber-100", children: "`orca.yaml` could not be parsed" }), _jsx("p", { className: "text-sm leading-6 text-muted-foreground", children: "The file is present, but Orca could not find valid `scripts` or `issueCommand` definitions in the expected format." })] }), _jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.18em] text-muted-foreground", children: "Recommended fixes" }), _jsx("ol", { className: "space-y-2.5 text-sm text-muted-foreground", children: PARSE_ERROR_FIXES.map((fix, index) => (_jsxs("li", { className: "flex items-start gap-3", children: [_jsx("span", { className: "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground", children: index + 1 }), _jsx("span", { className: "leading-6", children: fix })] }, fix))) })] })] })] }), _jsx(ExampleTemplateCard, { copiedTemplate: copiedTemplate, onCopyTemplate: onCopyTemplate })] })) : (_jsx(ExampleTemplateCard, { copiedTemplate: copiedTemplate, onCopyTemplate: onCopyTemplate }))] }) }), legacyHookEntries.length > 0 ? (_jsx(SearchableSetting, { title: "Legacy Repo-Local Hooks", description: "Older setup and archive hook scripts stored in local repo settings.", keywords: ['legacy', 'fallback', 'setup', 'archive'], children: _jsxs("div", { className: "space-y-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 shadow-sm", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h5", { className: "text-sm font-semibold text-amber-700 dark:text-amber-300", children: "Legacy Repo-Local Hooks" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "These older commands still run as a fallback when `orca.yaml` does not provide a hook. Clear them after you migrate the behavior into `orca.yaml`." })] }), _jsx(Button, { type: "button", variant: "outline", size: "sm", onClick: onClearLegacyHooks, children: "Clear Legacy Hooks" })] }), legacyHookEntries.map(([hookName, script]) => (_jsxs("div", { className: "space-y-2 rounded-xl border border-amber-500/20 bg-background/70 p-3", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("p", { className: "text-xs font-medium capitalize text-foreground", children: hookName }), _jsx("span", { className: "text-[10px] text-muted-foreground", children: "Compatibility fallback" })] }), _jsx("pre", { className: "overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-[11px] leading-5 text-foreground", children: script })] }, hookName)))] }) })) : null, _jsx(SearchableSetting, { title: "When to Run Setup", description: "Choose the default behavior when a setup command is available.", keywords: ['setup run policy', 'ask', 'run by default', 'skip by default'], children: _jsxs("div", { className: "space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h5", { className: "text-sm font-semibold", children: "When to Run Setup" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Choose the default behavior when a setup command is available." })] }), _jsx(PolicyOptionGrid, { options: SETUP_RUN_POLICY_OPTIONS, selected: selectedSetupRunPolicy, onSelect: onUpdateSetupRunPolicy, columns: "md:grid-cols-3" })] }) }), _jsx(SearchableSetting, { title: "Custom GitHub Issue Command", description: "Optional per-user override for the linked-issue command.", keywords: ['github issue command', 'issue command', 'workflow', 'agent', 'github'], children: _jsxs("div", { className: "space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm", children: [_jsx("div", { className: "space-y-1", children: _jsx("h5", { className: "text-sm font-semibold", children: "Custom GitHub Issue Command" }) }), _jsxs("div", { className: "space-y-2", children: [_jsx("textarea", { value: issueCommandDraft, onChange: (e) => setIssueCommandDraft(e.target.value), onBlur: commitIssueCommand, placeholder: "Complete {{artifact_url}}", rows: 5, className: "w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Use ", _jsx("code", { className: "rounded bg-muted px-1 py-0.5", children: '{{artifact_url}}' }), " for the linked issue or PR URL. Leave empty to use the built-in", ' ', _jsxs("code", { className: "rounded bg-muted px-1 py-0.5", children: ["Complete ", '{{artifact_url}}'] }), ' ', "default."] }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Leave blank to use the repo default from", ' ', _jsx("code", { className: "rounded bg-muted px-1 py-0.5", children: "orca.yaml" }), hasSharedIssueCommand ? '.' : ' when one exists.'] }), issueCommandSaveError ? (_jsx("p", { className: "text-xs text-destructive", children: issueCommandSaveError })) : null] })] }) })] }));
}
const PARSE_ERROR_FIXES = [
    'Check the indentation under `scripts:`. Hook keys should use two spaces, and command lines should use four.',
    'Define only the supported keys: `scripts`, `setup`, `archive`, and `issueCommand`.',
    'Compare your file against the working template below and copy that shape if needed.'
];
function renderYamlScriptPreview(hooks) {
    const fmt = (key, cmd) => cmd ? `\n  ${key}: |\n${cmd.replace(/^/gm, '    ')}` : '';
    const issueCommand = hooks?.issueCommand
        ? `\nissueCommand: |\n${hooks.issueCommand.replace(/^/gm, '  ')}`
        : '';
    return `scripts:${fmt('setup', hooks?.scripts.setup)}${fmt('archive', hooks?.scripts.archive)}${issueCommand}`;
}

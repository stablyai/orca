/* eslint-disable max-lines -- Why: terminal pane lifecycle wiring is intentionally co-located so PTY attach, theme sync, and runtime graph publication remain consistent for live terminals. */
import { useEffect, useRef } from 'react';
import { PaneManager } from '@/lib/pane-manager/pane-manager';
import { useAppStore } from '@/store';
import { createFilePathLinkProvider, getTerminalFileOpenHint, getTerminalUrlOpenHint, handleOscLink } from './terminal-link-handlers';
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts';
import { buildFontFamily, collectLeafIdsInReplayCreationOrder, replayTerminalLayout, restoreScrollbackBuffers } from './layout-serialization';
import { applyExpandedLayoutTo, restoreExpandedLayoutFrom } from './expand-collapse';
import { applyTerminalAppearance } from './terminal-appearance';
import { connectPanePty } from './pty-connection';
import { fitAndFocusPanes, fitPanes } from './pane-helpers';
import { registerRuntimeTerminalTab, scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph';
/** Scopes `deps.startup` to a single call of `splitPane()`, clearing it in `finally` so later splits do not replay the payload. */
export function splitPaneWithOneShotStartup(deps, startup, splitPane) {
    // Why: the startup payload is only for the pane created by this split.
    // Pane creation fans out through onPaneCreated using a spread copy of `deps`,
    // so connectPanePty cannot clear the caller's original object for us.
    // Reset the shared field in finally so later user-driven splits never replay
    // setup/issue commands, even if splitPane throws during creation.
    // Relies on manager.splitPane → onPaneCreated → connectPanePty reading
    // `deps.startup` synchronously before returning; if that chain ever becomes
    // async, this helper must switch to awaiting the split before clearing.
    deps.startup = startup;
    try {
        return splitPane();
    }
    finally {
        deps.startup = null;
    }
}
export function useTerminalPaneLifecycle({ tabId, worktreeId, cwd, startup, setupSplit, issueCommandSplit, isActive, systemPrefersDark, settings, settingsRef, initialLayoutRef, managerRef, containerRef, expandedStyleSnapshotRef, paneFontSizesRef, paneTransportsRef, panePtyBindingsRef, pendingWritesRef, isActiveRef, isVisibleRef, onPtyExitRef, onPtyErrorRef, clearTabPtyId, consumeSuppressedPtyExit, updateTabTitle, setRuntimePaneTitle, clearRuntimePaneTitle, updateTabPtyId, markWorktreeUnread, dispatchNotification, setCacheTimerStartedAt, syncPanePtyLayoutBinding, setTabPaneExpanded, setTabCanExpandPane, setExpandedPane, syncExpandedLayout, persistLayoutSnapshot, setPaneTitles, paneTitlesRef, setRenamingPaneId }) {
    const systemPrefersDarkRef = useRef(systemPrefersDark);
    systemPrefersDarkRef.current = systemPrefersDark;
    const linkProviderDisposablesRef = useRef(new Map());
    const applyAppearance = (manager) => {
        const currentSettings = settingsRef.current;
        if (!currentSettings) {
            return;
        }
        applyTerminalAppearance(manager, currentSettings, systemPrefersDarkRef.current, paneFontSizesRef.current, paneTransportsRef.current);
    };
    // Initialize PaneManager instance once
    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        const expandedStyleSnapshots = expandedStyleSnapshotRef.current;
        const paneTransports = paneTransportsRef.current;
        const panePtyBindings = panePtyBindingsRef.current;
        const pendingWrites = pendingWritesRef.current;
        const linkDisposables = linkProviderDisposablesRef.current;
        const worktreePath = useAppStore
            .getState()
            .allWorktrees()
            .find((candidate) => candidate.id === worktreeId)?.path ??
            cwd ??
            '';
        const startupCwd = cwd ?? worktreePath;
        const pathExistsCache = new Map();
        const linkDeps = {
            worktreeId,
            worktreePath,
            startupCwd,
            managerRef,
            linkProviderDisposablesRef,
            pathExistsCache
        };
        let resizeRaf = null;
        const queueResizeAll = (focusActive) => {
            if (resizeRaf !== null) {
                cancelAnimationFrame(resizeRaf);
            }
            resizeRaf = requestAnimationFrame(() => {
                resizeRaf = null;
                const manager = managerRef.current;
                if (!manager) {
                    return;
                }
                if (focusActive) {
                    fitAndFocusPanes(manager);
                    return;
                }
                fitPanes(manager);
            });
        };
        const syncCanExpandState = () => {
            const paneCount = managerRef.current?.getPanes().length ?? 1;
            setTabCanExpandPane(tabId, paneCount > 1);
        };
        let shouldPersistLayout = false;
        const restoredLeafIdsInCreationOrder = collectLeafIdsInReplayCreationOrder(initialLayoutRef.current.root);
        let restoredPaneCreateIndex = 0;
        const ptyDeps = {
            tabId,
            worktreeId,
            cwd,
            startup,
            paneTransportsRef,
            pendingWritesRef,
            isActiveRef,
            isVisibleRef,
            onPtyExitRef,
            onPtyErrorRef,
            clearTabPtyId,
            consumeSuppressedPtyExit,
            updateTabTitle,
            setRuntimePaneTitle,
            clearRuntimePaneTitle,
            updateTabPtyId,
            markWorktreeUnread,
            dispatchNotification,
            setCacheTimerStartedAt,
            syncPanePtyLayoutBinding,
            restoredPtyIdByLeafId: initialLayoutRef.current.ptyIdsByLeafId ?? {}
        };
        const unregisterRuntimeTab = registerRuntimeTerminalTab({
            tabId,
            worktreeId,
            getManager: () => managerRef.current,
            getContainer: () => containerRef.current,
            getPtyIdForPane: (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
        });
        const fileOpenLinkHint = getTerminalFileOpenHint();
        const urlOpenLinkHint = getTerminalUrlOpenHint();
        const manager = new PaneManager(container, {
            onPaneCreated: (pane) => {
                const linkProviderDisposable = pane.terminal.registerLinkProvider(createFilePathLinkProvider(pane.id, linkDeps, pane.linkTooltip, fileOpenLinkHint));
                linkProviderDisposablesRef.current.set(pane.id, linkProviderDisposable);
                pane.terminal.options.linkHandler = {
                    allowNonHttpProtocols: true,
                    activate: (event, text) => handleOscLink(text, event, linkDeps),
                    // Show bottom-left tooltip on hover for OSC 8 hyperlinks (e.g.
                    // GitHub owner/repo#issue references emitted by CLI tools) — same
                    // behaviour as the WebLinksAddon provides for plain-text URLs.
                    hover: (_event, text) => {
                        pane.linkTooltip.textContent = `${text} (${urlOpenLinkHint})`;
                        pane.linkTooltip.style.display = '';
                    },
                    leave: () => {
                        pane.linkTooltip.style.display = 'none';
                    }
                };
                applyAppearance(manager);
                const restoredLeafId = restoredLeafIdsInCreationOrder[restoredPaneCreateIndex] ?? null;
                restoredPaneCreateIndex += 1;
                const panePtyBinding = connectPanePty(pane, manager, {
                    ...ptyDeps,
                    restoredLeafId
                });
                panePtyBindings.set(pane.id, panePtyBinding);
                scheduleRuntimeGraphSync();
                queueResizeAll(true);
            },
            onPaneClosed: (paneId) => {
                const linkProviderDisposable = linkProviderDisposablesRef.current.get(paneId);
                if (linkProviderDisposable) {
                    linkProviderDisposable.dispose();
                    linkProviderDisposablesRef.current.delete(paneId);
                }
                const transport = paneTransportsRef.current.get(paneId);
                const panePtyBinding = panePtyBindings.get(paneId);
                if (panePtyBinding) {
                    panePtyBinding.dispose();
                    panePtyBindings.delete(paneId);
                }
                if (transport) {
                    const ptyId = transport.getPtyId();
                    if (ptyId) {
                        syncPanePtyLayoutBinding(paneId, null);
                        clearTabPtyId(tabId, ptyId);
                    }
                    transport.destroy?.();
                    paneTransportsRef.current.delete(paneId);
                }
                clearRuntimePaneTitle(tabId, paneId);
                paneFontSizesRef.current.delete(paneId);
                pendingWritesRef.current.delete(paneId);
                // Clean up pane title state so closed panes don't leave stale entries.
                setPaneTitles((prev) => {
                    if (!(paneId in prev)) {
                        return prev;
                    }
                    const next = { ...prev };
                    delete next[paneId];
                    return next;
                });
                // Eagerly update the ref so persistLayoutSnapshot (called from
                // onLayoutChanged which fires right after onPaneClosed) reads the
                // correct titles without waiting for React's async state flush.
                if (paneId in paneTitlesRef.current) {
                    const next = { ...paneTitlesRef.current };
                    delete next[paneId];
                    paneTitlesRef.current = next;
                }
                // Dismiss the rename dialog if it was open for the closed pane,
                // otherwise it would submit against a non-existent pane.
                setRenamingPaneId((prev) => (prev === paneId ? null : prev));
                // Why: PaneManager.closePane() reassigns activePaneId directly without
                // calling setActivePane(), so onActivePaneChange does not fire. Sync the
                // tab title to the survivor's stored title here so the tab label doesn't
                // stay stuck on the closed pane's last title.
                const newActivePane = managerRef.current?.getActivePane();
                if (newActivePane) {
                    const paneTitles = useAppStore.getState().runtimePaneTitlesByTabId[tabId] ?? {};
                    const activeTitle = paneTitles[newActivePane.id];
                    if (activeTitle) {
                        updateTabTitle(tabId, activeTitle);
                    }
                }
                scheduleRuntimeGraphSync();
            },
            onActivePaneChange: (pane) => {
                scheduleRuntimeGraphSync();
                if (shouldPersistLayout) {
                    persistLayoutSnapshot();
                }
                // Why: when the user switches focus between split panes, update the
                // tab title to the newly active pane's last-known title so the tab
                // label reflects the focused agent — not a stale title from the
                // previously focused pane.
                const paneTitles = useAppStore.getState().runtimePaneTitlesByTabId[tabId] ?? {};
                const paneTitle = paneTitles[pane.id];
                if (paneTitle) {
                    updateTabTitle(tabId, paneTitle);
                }
            },
            onLayoutChanged: () => {
                scheduleRuntimeGraphSync();
                syncExpandedLayout();
                syncCanExpandState();
                queueResizeAll(false);
                if (shouldPersistLayout) {
                    persistLayoutSnapshot();
                }
            },
            terminalOptions: () => {
                const currentSettings = settingsRef.current;
                const terminalFontWeights = resolveTerminalFontWeights(currentSettings?.terminalFontWeight);
                return {
                    fontSize: currentSettings?.terminalFontSize ?? 14,
                    fontFamily: buildFontFamily(currentSettings?.terminalFontFamily ?? ''),
                    fontWeight: terminalFontWeights.fontWeight,
                    fontWeightBold: terminalFontWeights.fontWeightBold,
                    scrollback: Math.min(50_000, Math.max(1000, Math.round((currentSettings?.terminalScrollbackBytes ?? 10_000_000) / 200))),
                    cursorStyle: currentSettings?.terminalCursorStyle ?? 'bar',
                    cursorBlink: currentSettings?.terminalCursorBlink ?? true,
                    macOptionIsMeta: currentSettings?.terminalMacOptionAsAlt === 'true'
                };
            },
            onLinkClick: (event, url) => {
                if (!event) {
                    return;
                }
                void handleOscLink(url, event, linkDeps);
            }
        });
        managerRef.current = manager;
        const restoredPaneByLeafId = replayTerminalLayout(manager, initialLayoutRef.current, isActive);
        restoreScrollbackBuffers(manager, initialLayoutRef.current.buffersByLeafId, restoredPaneByLeafId);
        // Seed pane titles from the persisted snapshot using the same
        // old-leafId → new-paneId mapping used for buffer restore.
        const savedTitles = initialLayoutRef.current.titlesByLeafId;
        if (savedTitles) {
            const restored = {};
            for (const [oldLeafId, title] of Object.entries(savedTitles)) {
                const newPaneId = restoredPaneByLeafId.get(oldLeafId);
                if (newPaneId != null && title) {
                    restored[newPaneId] = title;
                }
            }
            if (Object.keys(restored).length > 0) {
                // Merge (not replace) so we don't discard any concurrent state
                // updates from onPaneClosed that React may have batched.
                setPaneTitles((prev) => ({ ...prev, ...restored }));
            }
        }
        const restoredActivePaneId = (initialLayoutRef.current.activeLeafId
            ? restoredPaneByLeafId.get(initialLayoutRef.current.activeLeafId)
            : null) ??
            manager.getActivePane()?.id ??
            manager.getPanes()[0]?.id ??
            null;
        if (restoredActivePaneId !== null) {
            manager.setActivePane(restoredActivePaneId, { focus: isActive });
        }
        const restoredExpandedPaneId = initialLayoutRef.current.expandedLeafId
            ? (restoredPaneByLeafId.get(initialLayoutRef.current.expandedLeafId) ?? null)
            : null;
        if (restoredExpandedPaneId !== null && manager.getPanes().length > 1) {
            setExpandedPane(restoredExpandedPaneId);
            applyExpandedLayoutTo(restoredExpandedPaneId, {
                managerRef,
                containerRef,
                expandedStyleSnapshotRef
            });
        }
        else {
            setExpandedPane(null);
        }
        // Why: setup split creates a right-side pane for the setup script so the
        // main (left) terminal stays immediately usable. We inject the setup command
        // into ptyDeps.startup right before splitting and clear it immediately after
        // — connectPanePty receives a spread copy (`{...ptyDeps}`), so mutations
        // inside connectPanePty don't propagate back to ptyDeps. Without clearing
        // here, any later user-initiated split (e.g. Cmd+D) would re-run the setup
        // command in the newly created pane.
        let issueAutomationAnchorPaneId = null;
        // Why: capture the main shell pane *before* any splits mutate the pane list.
        // Both the setup and issue-command paths need to restore focus back to this
        // pane after creating their splits, so we save the reference once rather
        // than relying on getPanes()[0] which returns insertion order, not visual order.
        const initialPane = manager.getActivePane() ?? manager.getPanes()[0];
        if (setupSplit) {
            if (initialPane) {
                const setupPane = splitPaneWithOneShotStartup(ptyDeps, { command: setupSplit.command, env: setupSplit.env }, () => manager.splitPane(initialPane.id, setupSplit.direction));
                issueAutomationAnchorPaneId = setupPane?.id ?? null;
                // Restore focus to the main pane so the user's terminal receives
                // keyboard input — the setup pane runs unattended.
                manager.setActivePane(initialPane.id, { focus: isActive });
            }
        }
        // Why: when the user links a GitHub issue during worktree creation and has
        // enabled that repo's issue automation, spawn a separate split pane to run
        // the agent command. This runs independently from setup: the issue command
        // is a per-user prompt/template rather than repo bootstrap, so Orca should
        // not guess at ordering requirements that vary by user workflow.
        if (issueCommandSplit) {
            const targetPane = (issueAutomationAnchorPaneId !== null
                ? (manager.getPanes().find((pane) => pane.id === issueAutomationAnchorPaneId) ?? null)
                : null) ??
                manager.getActivePane() ??
                manager.getPanes()[0];
            if (targetPane) {
                splitPaneWithOneShotStartup(ptyDeps, { command: issueCommandSplit.command, env: issueCommandSplit.env }, () => manager.splitPane(targetPane.id, 'vertical'));
                // Why: if setup already claimed the right half, nest issue automation
                // inside that automation area instead of splitting the main shell again.
                // This preserves the primary terminal as the dominant pane while setup
                // and issue panes share the secondary column.
                const focusPaneId = issueAutomationAnchorPaneId !== null ? (initialPane?.id ?? targetPane.id) : targetPane.id;
                manager.setActivePane(focusPaneId, { focus: isActive });
            }
        }
        shouldPersistLayout = true;
        syncCanExpandState();
        applyAppearance(manager);
        queueResizeAll(isActive);
        persistLayoutSnapshot();
        scheduleRuntimeGraphSync();
        return () => {
            const tabStillExists = Boolean(useAppStore
                .getState()
                .tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId));
            unregisterRuntimeTab();
            if (resizeRaf !== null) {
                cancelAnimationFrame(resizeRaf);
            }
            restoreExpandedLayoutFrom(expandedStyleSnapshots);
            for (const disposable of linkDisposables.values()) {
                disposable.dispose();
            }
            linkDisposables.clear();
            for (const transport of paneTransports.values()) {
                if (tabStillExists && transport.getPtyId()) {
                    // Why: moving a terminal tab between groups currently rehomes the
                    // React subtree, which unmounts this TerminalPane even though the tab
                    // itself is still alive. Detaching preserves the running PTY so the
                    // remounted pane can reattach without restarting the user's shell.
                    // Transports that have not attached yet still have no PTY ID; those
                    // must be destroyed so any in-flight spawn resolves into a killed PTY
                    // instead of reviving a stale binding after unmount.
                    transport.detach?.();
                }
                else {
                    transport.destroy?.();
                }
            }
            for (const panePtyBinding of panePtyBindings.values()) {
                panePtyBinding.dispose();
            }
            panePtyBindings.clear();
            paneTransports.clear();
            pendingWrites.clear();
            manager.destroy();
            managerRef.current = null;
            setTabPaneExpanded(tabId, false);
            setTabCanExpandPane(tabId, false);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId, cwd]);
    useEffect(() => {
        const manager = managerRef.current;
        if (!manager || !settings) {
            return;
        }
        applyAppearance(manager);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings, systemPrefersDark]);
}

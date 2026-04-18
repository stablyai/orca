import type { BrowserPage, BrowserWorkspace, WorkspaceSessionState, WorkspaceVisibleTabType } from '../../../shared/types';
import type { AppState } from '../store';
import type { OpenFile } from '../store/slices/editor';
type WorkspaceSessionSnapshot = Pick<AppState, 'activeRepoId' | 'activeWorktreeId' | 'activeTabId' | 'tabsByWorktree' | 'terminalLayoutsByTabId' | 'activeTabIdByWorktree' | 'openFiles' | 'activeFileIdByWorktree' | 'activeTabTypeByWorktree' | 'browserTabsByWorktree' | 'browserPagesByWorkspace' | 'activeBrowserTabIdByWorktree' | 'browserUrlHistory' | 'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree' | 'activeGroupIdByWorktree'>;
/** Build the editor-file portion of the workspace session for persistence.
 *  Only edit-mode files are saved — diffs and conflict views are transient. */
export declare function buildEditorSessionData(openFiles: OpenFile[], activeFileIdByWorktree: Record<string, string | null>, activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>): Pick<WorkspaceSessionState, 'openFilesByWorktree' | 'activeFileIdByWorktree' | 'activeTabTypeByWorktree'>;
export declare function buildBrowserSessionData(browserTabsByWorktree: Record<string, BrowserWorkspace[]>, browserPagesByWorkspace: Record<string, BrowserPage[]>, activeBrowserTabIdByWorktree: Record<string, string | null>): Pick<WorkspaceSessionState, 'browserTabsByWorktree' | 'browserPagesByWorkspace' | 'activeBrowserTabIdByWorktree'>;
export declare function buildWorkspaceSessionPayload(snapshot: WorkspaceSessionSnapshot): WorkspaceSessionState;
export {};

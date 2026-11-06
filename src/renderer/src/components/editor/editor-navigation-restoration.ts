import { useAppStore } from '@/store';
import type { AppState } from '@/store/types';
import type { OpenFile } from '@/store/slices/editor';
import { assertEditorFileOperationCurrent } from '@/lib/editor-file-operation-owner';
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal';
import { getEditorModelOwnerKey } from './model-lifetime/identity/editor-model-owner';
import type {
  RestorationState,
  MountedEditor,
  Location,
  FileDescriptor
} from './editor-navigation.types';
import { TAB_TYPE, DELETED_FILE_MUTATION, FILE_MODE } from './editor-navigation.consts';

const restoration: RestorationState = { pending: null, editors: new Map() };

export function cancelRestore(): void {
  restoration.pending = null;
}

export function hasPendingRestore(): boolean {
  return restoration.pending !== null;
}

export function isRestoring(): boolean {
  return restoration.pending !== null && isCurrentRestore(restoration.pending);
}

export function registerEditor(key: string, mounted: MountedEditor): () => void {
  restoration.editors.set(key, mounted);

  return () => {
    if (restoration.editors.get(key) === mounted) {
      restoration.editors.delete(key);
    }
  };
}

function isCurrentRestore(location: Location): boolean {
  const state = useAppStore.getState();
  const tab = state.getActiveTab(location.file.worktreeId);
  const file = state.openFiles.find((candidate) => candidate.id === location.file.id);

  return (
    restoration.pending === location &&
    state.activeWorktreeId === location.file.worktreeId &&
    state.activeTabType === TAB_TYPE &&
    state.activeFileId === location.file.id &&
    file !== undefined &&
    getEditorModelOwnerKey(file, state) === location.ownerKey &&
    (!location.tabId || tab?.id === location.tabId)
  );
}

function hasCurrentOwner(
  state: AppState,
  location: Location,
  existing: OpenFile | undefined
): boolean {
  if (getEditorModelOwnerKey(existing ?? location.file, state) !== location.ownerKey) {
    return false;
  }

  try {
    const { file } = location;

    if (file.operationProvenance) {
      assertEditorFileOperationCurrent(state, file.worktreeId, file.operationProvenance);
    }

    return true;
  } catch {
    return false;
  }
}

export function canRestoreLocation(location: Location): boolean {
  const state = useAppStore.getState();
  const existing = state.openFiles.find((candidate) => candidate.id === location.file.id);

  return (
    hasCurrentOwner(state, location, existing) &&
    (existing !== undefined ||
      (!location.file.isUntitled && location.file.externalMutation !== DELETED_FILE_MUTATION))
  );
}

function withActiveTab(location: Location): Location {
  const tabId = useAppStore.getState().getActiveTab(location.file.worktreeId)?.id;

  return { ...location, tabId, viewStateId: tabId ?? location.file.id };
}

function activateExistingLocation(state: AppState, location: Location, file: OpenFile): Location {
  state.setActiveFile(file.id, file.worktreeId);
  const tab = location.tabId ? state.getTab(location.tabId) : null;

  if (tab?.entityId === file.id) {
    state.activateTab(tab.id);

    return location;
  }

  return withActiveTab(location);
}

function reopenFileDescriptor(file: OpenFile): FileDescriptor {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    language: file.language,
    mode: FILE_MODE,
    runtimeEnvironmentId: file.runtimeEnvironmentId,
    externalSshTargetId: file.externalSshTargetId,
    terminalArtifactGrantId: file.terminalArtifactGrantId,
    operationProvenance: file.operationProvenance,
    readOnly: file.readOnly
  };
}

function reopenLocation(state: AppState, location: Location): Location {
  const id = state.openFile(reopenFileDescriptor(location.file), { preview: true });

  return withActiveTab({ ...location, file: { ...location.file, id } });
}

function finishRestore(location: Location): void {
  const mounted = restoration.editors.get(location.viewStateId ?? location.file.id);
  mounted?.editor.setScrollPosition({
    scrollTop: location.scrollTop,
    scrollLeft: location.scrollLeft
  });
  cancelRestore();
  mounted?.record();
}

function revealLocation(location: Location): void {
  scheduleEditorLineReveal(
    useAppStore.getState,
    location.file.filePath,
    location.position.lineNumber,
    location.position.column,
    location.file.id,
    {
      viewStateId: location.viewStateId,
      canApply: () => isCurrentRestore(location),
      onApplied: () => finishRestore(location)
    }
  );
}

export function restoreLocation(location: Location): Location {
  const state = useAppStore.getState();
  const existing = state.openFiles.find((candidate) => candidate.id === location.file.id);
  restoration.pending = location;
  const target = existing
    ? activateExistingLocation(state, location, existing)
    : reopenLocation(state, location);
  restoration.pending = target;
  state.setActiveTabType(TAB_TYPE, target.file.worktreeId);
  revealLocation(target);

  return target;
}

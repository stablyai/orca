import { create } from 'zustand'
import { invokeNative, isTauriNativeHost, listenNative } from '@/web/tauri-native-host'
import { navigateToSourceLocation } from '../debug/debug-session-paths'
import { executeCodeRenameCommit, type CodeIntelligenceState } from './code-intelligence-actions'
import {
  runBeginRenameFlow,
  runCodeGotoFlow,
  runFindReferencesFlow,
  runOpenOutlineFlow
} from './code-intelligence-operations'
import type {
  LspDiagnosticsEvent,
  LspRuntimeStatusEvent,
  LspServerStatus
} from './code-intelligence-types'
import { CodeNavigationHistory } from './code-navigation-history'

const navHistory = new CodeNavigationHistory()
const liveBufferReaders = new Map<string, () => string>()
let listenersInstalled = false
let hintTimer: ReturnType<typeof setTimeout> | null = null

export type {
  CodeChooserState,
  CodeContextMenuRequest,
  CodeOutlineState,
  CodeRenameRequest,
  CodeStatusHint
} from './code-intelligence-actions'

export function registerLiveCodeBufferReader(fileKey: string, reader: () => string): () => void {
  liveBufferReaders.set(fileKey, reader)
  return () => {
    if (liveBufferReaders.get(fileKey) === reader) {
      liveBufferReaders.delete(fileKey)
    }
  }
}

export const useCodeIntelligenceStore = create<CodeIntelligenceState>((set, get) => {
  const callbacks = {
    history: navHistory,
    jumpToLocation: (
      target: { filePath: string; line: number; column?: number },
      origin?: { filePath: string; line: number; column: number }
    ) => get().jumpToLocation(target, origin),
    showStatusHint: (hint: NonNullable<CodeIntelligenceState['statusHint']>) =>
      get().showStatusHint(hint),
    setChooser: (chooser: CodeIntelligenceState['chooser']) => set({ chooser }),
    setOutline: (outline: CodeIntelligenceState['outline']) => set({ outline }),
    setRenameRequest: (renameRequest: CodeIntelligenceState['renameRequest']) =>
      set({ renameRequest })
  }

  return {
    diagnosticsByFile: {},
    runtimeStatusByServer: {},
    serverStatuses: [],
    installingServerId: null,
    canGoBack: false,
    canGoForward: false,
    chooser: null,
    outline: null,
    renameRequest: null,
    contextMenu: null,
    statusHint: null,

    recordCursorPlace: (filePath, line, column) => {
      navHistory.update({ filePath, line, column }, false)
      set({ canGoBack: navHistory.canGoBack(), canGoForward: navHistory.canGoForward() })
    },

    jumpToLocation: (target, origin) => {
      if (origin) {
        navHistory.recordJump(origin, {
          filePath: target.filePath,
          line: target.line,
          column: target.column ?? 1
        })
      } else {
        navHistory.update(
          { filePath: target.filePath, line: target.line, column: target.column ?? 1 },
          true
        )
      }
      set({
        canGoBack: navHistory.canGoBack(),
        canGoForward: navHistory.canGoForward(),
        chooser: null,
        outline: null
      })
      navigateToSourceLocation(target.filePath, target.line, target.column ?? 1)
    },

    navigateBack: () => {
      const loc = navHistory.back()
      if (!loc) {
        return false
      }
      set({ canGoBack: navHistory.canGoBack(), canGoForward: navHistory.canGoForward() })
      navigateToSourceLocation(loc.filePath, loc.line, loc.column)
      return true
    },

    navigateForward: () => {
      const loc = navHistory.forward()
      if (!loc) {
        return false
      }
      set({ canGoBack: navHistory.canGoBack(), canGoForward: navHistory.canGoForward() })
      navigateToSourceLocation(loc.filePath, loc.line, loc.column)
      return true
    },

    closeChooser: () => set({ chooser: null }),
    closeOutline: () => set({ outline: null }),
    closeRename: () => set({ renameRequest: null }),
    openContextMenu: (req) => set({ contextMenu: req }),
    closeContextMenu: () => set({ contextMenu: null }),

    showStatusHint: (hint) => {
      if (hintTimer) {
        clearTimeout(hintTimer)
      }
      set({ statusHint: hint })
      hintTimer = setTimeout(() => {
        set({ statusHint: null })
        hintTimer = null
      }, 3200)
    },

    dismissStatusHint: () => {
      if (hintTimer) {
        clearTimeout(hintTimer)
        hintTimer = null
      }
      set({ statusHint: null })
    },

    runGoto: (params) => runCodeGotoFlow(params, callbacks),
    runFindReferences: (params) => runFindReferencesFlow(params, callbacks),
    openOutline: (params) => runOpenOutlineFlow(params, callbacks),
    beginRename: (params) => runBeginRenameFlow(params, callbacks),

    commitRename: async (newName) => {
      const req = get().renameRequest
      if (!req) {
        return
      }
      const trimmed = newName.trim()
      set({ renameRequest: null })
      if (!trimmed || trimmed === req.currentName) {
        return
      }
      const message = await executeCodeRenameCommit(
        req,
        trimmed,
        (key) => liveBufferReaders.get(key)?.() ?? null
      )
      if (message) {
        get().showStatusHint({ text: message, tone: 'info' })
      }
    },

    refreshServerStatuses: async (workspaceRoot) => {
      if (!isTauriNativeHost()) {
        return
      }
      try {
        const serverStatuses = await invokeNative<LspServerStatus[]>('poc_lsp_server_statuses', {
          workspaceRoot: workspaceRoot ?? null
        })
        set({ serverStatuses })
      } catch {
        // Non-fatal in UI status probe.
      }
    },

    installServer: async (serverId, workspaceRoot) => {
      if (!isTauriNativeHost()) {
        return
      }
      set({ installingServerId: serverId })
      try {
        await invokeNative<LspServerStatus>('poc_lsp_install_server', {
          serverId,
          workspaceRoot: workspaceRoot ?? null
        })
        await get().refreshServerStatuses(workspaceRoot)
        get().showStatusHint({ text: `Installed ${serverId}`, tone: 'info' })
      } catch (err) {
        get().showStatusHint({
          text: err instanceof Error ? err.message : String(err),
          tone: 'warning'
        })
      } finally {
        set({ installingServerId: null })
      }
    }
  }
})

export function installCodeLspEventListeners(): void {
  if (listenersInstalled || !isTauriNativeHost()) {
    return
  }
  listenersInstalled = true
  listenNative<LspDiagnosticsEvent>('lsp:diagnostics', (payload) => {
    useCodeIntelligenceStore.setState((state) => ({
      diagnosticsByFile: {
        ...state.diagnosticsByFile,
        [payload.fileKey]: payload.diagnostics
      }
    }))
  })
  listenNative<LspRuntimeStatusEvent>('lsp:status', (payload) => {
    useCodeIntelligenceStore.setState((state) => ({
      runtimeStatusByServer: {
        ...state.runtimeStatusByServer,
        [payload.serverId]: payload
      }
    }))
  })
}

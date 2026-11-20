import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

type Listener = { event: string; handler: (message: { payload: unknown }) => void }

function installTauriHost(): {
  invoke: ReturnType<typeof vi.fn>
  listeners: Listener[]
  emit: (event: string, payload: unknown) => void
  window: Window & typeof globalThis
} {
  const globals = installBrowserGlobals('Windows')
  const listeners: Listener[] = []
  const invoke = vi.fn((command: string) => {
    if (command === 'poc_is_maximized') {
      return Promise.resolve(false)
    }
    return Promise.resolve(null)
  })
  const event = {
    listen: vi.fn(async (name: string, handler: (message: { payload: unknown }) => void) => {
      listeners.push({ event: name, handler })
      return () => {
        const index = listeners.findIndex((listener) => listener.handler === handler)
        if (index !== -1) {
          listeners.splice(index, 1)
        }
      }
    })
  }
  Object.assign(globals.window, {
    __TAURI_INTERNALS__: { invoke },
    __TAURI__: { event }
  })
  return {
    invoke,
    listeners,
    emit: (eventName, payload) => {
      for (const listener of listeners) {
        if (listener.event === eventName) {
          listener.handler({ payload })
        }
      }
    },
    window: globals.window
  }
}

describe('tauri native bridge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps window controls and close handshake to Rust commands', async () => {
    const host = installTauriHost()
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()
    host.invoke.mockClear()

    ui.minimize?.()
    ui.maximize?.()
    ui.requestClose?.()
    ui.confirmWindowClose?.()
    ui.popupMenu?.()

    expect(host.invoke.mock.calls.map(([command]) => command)).toEqual([
      'poc_minimize',
      'poc_toggle_maximize',
      'poc_request_close',
      'poc_confirm_close',
      'poc_popup_menu'
    ])
  })

  it('routes native-chat paste restore through the Rust containment check', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_clipboard_restore_native_chat_pastes'
        ? Promise.resolve([{ path: 'C:\\pastes\\a.png', kept: true, exists: true }])
        : Promise.resolve(null)
    )
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()

    await expect(ui.restoreNativeChatPastes?.(['C:\\pastes\\a.png'])).resolves.toEqual([
      { path: 'C:\\pastes\\a.png', kept: true, exists: true }
    ])
    expect(host.invoke).toHaveBeenCalledWith('poc_clipboard_restore_native_chat_pastes', {
      paths: ['C:\\pastes\\a.png']
    })
  })

  it('provides native paste, selection, and focus-tracking surfaces', async () => {
    installTauriHost()
    const execCommand = vi.fn()
    vi.stubGlobal('document', { execCommand })
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()

    ui.performNativePaste?.({ mode: 'paste-and-match-style' })
    ui.performNativeSelectionAction?.('select-all')
    ui.performNativeSelectionAction?.('copy')

    expect(execCommand.mock.calls.map(([command]) => command)).toEqual([
      'paste',
      'selectAll',
      'copy'
    ])

    // Focus mirrors and the macOS traffic-light sync are present so callers
    // keep the same contract; they are inert on Tauri, whose shortcut routing
    // lives in the renderer keydown path.
    ui.setMarkdownEditorFocused?.(true)
    ui.setTerminalInputFocused?.(true)
    ui.setFloatingFocus?.({ panelFocused: true, terminalFocused: true })
    ui.setShortcutRecorderFocused?.(true)
    ui.setRichMarkdownContextMenuTarget?.(null)
    ui.syncTrafficLights?.(1.2)
    expect(ui.onRichMarkdownContextCommand?.(vi.fn())).toBeTypeOf('function')
  })

  it('durably checkpoints renderer state before a native relaunch', async () => {
    const host = installTauriHost()
    const checkpoint = vi.fn(() => Promise.resolve())
    Object.assign(host.window, {
      dispatchEvent: vi.fn(),
      api: { app: { awaitBeforeUnloadCheckpoint: checkpoint } }
    })
    const { createTauriNativeAppApi } = await import('./tauri-native-bridge')
    const app = createTauriNativeAppApi()

    await app.relaunch?.()

    expect(checkpoint).toHaveBeenCalledOnce()
    expect(host.invoke).toHaveBeenCalledWith('poc_relaunch', undefined)
  })

  it('refuses a native restart when the renderer checkpoint fails', async () => {
    const host = installTauriHost()
    const checkpoint = vi.fn(async () => {
      throw new Error('Checkpoint failed')
    })
    Object.assign(host.window, {
      dispatchEvent: vi.fn(),
      api: { app: { awaitBeforeUnloadCheckpoint: checkpoint } }
    })
    const { createTauriNativeAppApi } = await import('./tauri-native-bridge')
    const app = createTauriNativeAppApi()

    await expect(app.restart?.()).rejects.toThrow('Checkpoint failed')
    expect(host.invoke).not.toHaveBeenCalled()
  })

  it('delivers second-instance share links and opened documents to existing UI listeners', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) => {
      if (command === 'poc_consume_second_instance_events') {
        return Promise.resolve([{ id: 7, args: ['orca://skills/share/share-7'], cwd: 'C:\\repo' }])
      }
      if (command === 'poc_resolve_opened_documents') {
        return Promise.resolve([
          {
            filePath: 'C:\\repo\\notes.md',
            relativePath: 'notes.md',
            basename: 'notes.md',
            name: 'notes'
          }
        ])
      }
      return Promise.resolve(null)
    })
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()
    const share = vi.fn()
    const documents = vi.fn()
    ui.onOpenSkillShare?.(share)
    ui.onOpenMarkdownFiles?.(documents)

    await Promise.resolve()
    await Promise.resolve()

    expect(share).toHaveBeenCalledWith('share-7')
    expect(documents).toHaveBeenCalledWith([
      {
        filePath: 'C:\\repo\\notes.md',
        relativePath: 'notes.md',
        basename: 'notes.md',
        name: 'notes'
      }
    ])

    host.emit('app:second-instance', {
      id: 7,
      args: ['orca://skills/share/share-7'],
      cwd: 'C:\\repo'
    })
    expect(share).toHaveBeenCalledTimes(1)
  })

  it('bridges maximize, fullscreen, close, and zoom events from Tauri', async () => {
    const host = installTauriHost()
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()
    const maximized = vi.fn()
    const fullscreen = vi.fn()
    const close = vi.fn()
    const zoom = vi.fn()
    const browserZoom = vi.fn()

    ui.onMaximizeChanged?.(maximized)
    ui.onFullscreenChanged?.(fullscreen)
    ui.onWindowCloseRequested?.(close)
    ui.onTerminalZoom?.(zoom)
    ui.onZoomBrowserPage?.(browserZoom)
    await Promise.resolve()
    await Promise.resolve()

    host.emit('window:maximize-changed', true)
    host.emit('window:fullscreen-changed', true)
    host.emit('window:close-requested', { isQuitting: true, requestId: 4 })
    host.emit('terminal:zoom', 'out')
    host.emit('browser:guest-wheel-zoom', { browserPageId: 'bp-1', direction: 'in' })

    expect(maximized).toHaveBeenCalledWith(true)
    expect(fullscreen).toHaveBeenCalledWith(true)
    expect(close).toHaveBeenCalledWith({ isQuitting: true })
    expect(zoom).toHaveBeenCalledWith('out')
    expect(browserZoom).toHaveBeenCalledWith({ browserPageId: 'bp-1', direction: 'in' })
  })

  it('bridges application menu commands to the shared UI event API', async () => {
    const host = installTauriHost()
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()
    const paste = vi.fn()
    const selection = vi.fn()
    const leftSidebar = vi.fn()
    const rightSidebar = vi.fn()
    const worktreePalette = vi.fn()
    const statusBar = vi.fn()
    const setupGuide = vi.fn()
    const featureTour = vi.fn()
    const crashReport = vi.fn()
    const appearance = vi.fn()
    const editAction = vi.fn()

    ui.onAppMenuPaste?.(paste)
    ui.onAppMenuSelectionAction?.(selection)
    ui.onAppMenuEditAction?.(editAction)
    ui.onToggleLeftSidebar?.(leftSidebar)
    ui.onToggleRightSidebar?.(rightSidebar)
    ui.onToggleWorktreePalette?.(worktreePalette)
    ui.onToggleStatusBar?.(statusBar)
    ui.onOpenSetupGuide?.(setupGuide)
    ui.onOpenFeatureTour?.(featureTour)
    ui.onOpenCrashReport?.(crashReport)
    ui.onToggleAppearance?.(appearance)
    await Promise.resolve()
    await Promise.resolve()

    host.emit('orca:tauri-ui:appMenuPaste', null)
    host.emit('orca:tauri-ui:appMenuSelectionAction', 'select-all')
    host.emit('orca:tauri-ui:appMenuEditAction', 'undo')
    host.emit('orca:tauri-ui:toggleLeftSidebar', null)
    host.emit('orca:tauri-ui:toggleRightSidebar', null)
    host.emit('orca:tauri-ui:toggleWorktreePalette', null)
    host.emit('orca:tauri-ui:toggleStatusBar', null)
    host.emit('orca:tauri-ui:openSetupGuide', null)
    host.emit('orca:tauri-ui:openFeatureTour', null)
    host.emit('orca:tauri-ui:openCrashReport', null)
    host.emit('orca:tauri-ui:toggleAppearance', 'showTasksButton')

    expect(paste).toHaveBeenCalledOnce()
    expect(selection).toHaveBeenCalledWith('select-all')
    expect(editAction).toHaveBeenCalledWith('undo')
    expect(leftSidebar).toHaveBeenCalledOnce()
    expect(rightSidebar).toHaveBeenCalledOnce()
    expect(worktreePalette).toHaveBeenCalledOnce()
    expect(statusBar).toHaveBeenCalledOnce()
    expect(setupGuide).toHaveBeenCalledOnce()
    expect(featureTour).toHaveBeenCalledOnce()
    expect(crashReport).toHaveBeenCalledOnce()
    expect(appearance).toHaveBeenCalledWith('showTasksButton')
  })

  it('applies UI zoom through the Chromium-equivalent scale factor', async () => {
    const host = installTauriHost()
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()

    ui.setZoomLevel?.(1)

    expect(ui.getZoomLevel?.()).toBe(1)
    expect(host.invoke).toHaveBeenCalledWith('poc_set_zoom', {
      scaleFactor: 1.2,
      zoomLevel: 1
    })
  })

  it('validates dropped paths and reports bounded failures', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_validate_dropped_paths'
        ? Promise.resolve(['C:\\repo\\a.txt'])
        : Promise.resolve(null)
    )
    const { createTauriNativeFilesystemDropApi } = await import('./tauri-native-bridge')
    const fs = createTauriNativeFilesystemDropApi()

    await expect(
      fs?.prepareDroppedPaths?.({ paths: ['C:\\repo\\a.txt'], consumer: 'agent' })
    ).resolves.toEqual({ paths: ['C:\\repo\\a.txt'], failures: [] })
  })

  it('reports relative dropped paths as rejected', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_validate_dropped_paths'
        ? Promise.reject(new Error('invalid-path'))
        : Promise.resolve(null)
    )
    const { createTauriNativeFilesystemDropApi } = await import('./tauri-native-bridge')
    const fs = createTauriNativeFilesystemDropApi()

    await expect(
      fs?.prepareDroppedPaths?.({ paths: ['relative.txt'], consumer: 'agent' })
    ).resolves.toMatchObject({
      paths: [],
      failures: [{ target: 'rejected', reason: 'temp-copy-failed' }]
    })
  })

  it('uses native directory pickers for local project flows', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'plugin:dialog|open') {
        const options = args?.options
        const multiple =
          typeof options === 'object' && options !== null && 'multiple' in options
            ? options.multiple === true
            : false
        return Promise.resolve(multiple ? ['C:\\repo-a', 'C:\\repo-b'] : 'C:\\repo')
      }
      return Promise.resolve(null)
    })
    const { createTauriNativeRepositoriesApi } = await import('./tauri-native-bridge')
    const repos = createTauriNativeRepositoriesApi().repos

    await expect(repos?.pickFolder()).resolves.toBe('C:\\repo')
    await expect(repos?.pickFolders()).resolves.toEqual(['C:\\repo-a', 'C:\\repo-b'])
    await expect(repos?.pickDirectory()).resolves.toBe('C:\\repo')
    expect(host.invoke).toHaveBeenCalledTimes(3)
  })

  it('owns local file staging and terminal drop validation in Tauri', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) => {
      if (command === 'poc_stage_external_paths') {
        return Promise.resolve({
          sources: [
            {
              sourcePath: 'C:\\repo\\note.txt',
              status: 'staged',
              name: 'note.txt',
              kind: 'file',
              entries: [
                {
                  relativePath: '',
                  kind: 'file',
                  byteLength: 4,
                  inode: 0,
                  deviceId: 0,
                  modifiedAtMs: 1
                }
              ]
            }
          ]
        })
      }
      if (command === 'poc_validate_dropped_paths') {
        return Promise.resolve(['C:\\repo\\note.txt'])
      }
      return Promise.resolve(null)
    })
    const { createTauriNativeFilesystemApi } = await import('./tauri-native-bridge')
    const fs = createTauriNativeFilesystemApi()

    await expect(
      fs.stageExternalPathsForRuntimeUpload?.({ sourcePaths: ['C:\\repo\\note.txt'] })
    ).resolves.toMatchObject({ sources: [{ status: 'staged', name: 'note.txt' }] })
    await expect(
      fs.resolveDroppedPathsForAgent?.({ paths: ['C:\\repo\\note.txt'], worktreePath: 'C:\\repo' })
    ).resolves.toEqual({ resolvedPaths: ['C:\\repo\\note.txt'], skipped: [], failed: [] })
    expect(host.invoke.mock.calls.map(([command]) => command)).toEqual([
      'poc_stage_external_paths',
      'poc_validate_dropped_paths'
    ])
  })

  it('uses the native save dialog and streams downloads through Rust', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) => {
      if (command === 'plugin:dialog|save') {
        return Promise.resolve('C:\\Downloads\\report.pdf')
      }
      if (command === 'poc_start_downloaded_file') {
        return Promise.resolve({
          transferId: 'transfer-1',
          destinationPath: 'C:\\Downloads\\report.pdf'
        })
      }
      return Promise.resolve({ destinationPath: 'C:\\Downloads\\report.pdf' })
    })
    const { createTauriNativeFilesystemApi } = await import('./tauri-native-bridge')
    const fs = createTauriNativeFilesystemApi()

    await expect(fs.startDownloadedFile?.({ suggestedName: 'report.pdf' })).resolves.toEqual({
      canceled: false,
      transferId: 'transfer-1',
      destinationPath: 'C:\\Downloads\\report.pdf'
    })
    await fs.appendDownloadedFileChunk?.({ transferId: 'transfer-1', contentBase64: 'aGVsbG8=' })
    await fs.finishDownloadedFile?.({ transferId: 'transfer-1' })

    expect(host.invoke.mock.calls.map(([command]) => command)).toEqual([
      'plugin:dialog|save',
      'poc_start_downloaded_file',
      'poc_append_downloaded_file_chunk',
      'poc_finish_downloaded_file'
    ])
  })

  it('launches the default local external editor through structured native arguments', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_open_external_editor' ? Promise.resolve({ ok: true }) : Promise.resolve(null)
    )
    const { createTauriNativeShellApi } = await import('./tauri-native-shell-api')
    const shell = createTauriNativeShellApi()

    await expect(
      shell?.openInExternalEditor?.({ path: 'C:\\repo', ownerHostId: 'local' })
    ).resolves.toEqual({ ok: true })
    expect(host.invoke).toHaveBeenCalledWith('poc_open_external_editor', {
      args: { path: 'C:\\repo', ownerHostId: 'local' }
    })
  })

  it('passes Cursor as a structured editor name without shell text', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_open_external_editor' ? Promise.resolve({ ok: true }) : Promise.resolve(null)
    )
    const { createTauriNativeShellApi } = await import('./tauri-native-shell-api')
    const shell = createTauriNativeShellApi()

    await expect(
      shell?.openInExternalEditor?.({
        path: 'C:\\repo\\notes.md',
        command: 'cursor',
        ownerHostId: 'local'
      })
    ).resolves.toEqual({ ok: true })
    expect(host.invoke).toHaveBeenCalledWith('poc_open_external_editor', {
      args: { path: 'C:\\repo\\notes.md', command: 'cursor', ownerHostId: 'local' }
    })
  })

  it('passes the WSL distro through to the native editor launcher', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_open_external_editor' ? Promise.resolve({ ok: true }) : Promise.resolve(null)
    )
    const { createTauriNativeShellApi } = await import('./tauri-native-shell-api')
    const shell = createTauriNativeShellApi()

    await expect(
      shell?.openInExternalEditor?.({
        path: '/home/ada/project',
        command: 'code',
        ownerHostId: 'runtime:wsl-1',
        wslDistro: 'Ubuntu'
      })
    ).resolves.toEqual({ ok: true })
    expect(host.invoke).toHaveBeenCalledWith('poc_open_external_editor', {
      args: {
        path: '/home/ada/project',
        command: 'code',
        ownerHostId: 'runtime:wsl-1',
        wslDistro: 'Ubuntu'
      }
    })
  })

  it('keeps remote editor rejection in the native result vocabulary', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_open_external_editor'
        ? Promise.resolve({ ok: false, reason: 'remote-editor-unsupported' })
        : Promise.resolve(null)
    )
    const { createTauriNativeShellApi } = await import('./tauri-native-shell-api')
    const shell = createTauriNativeShellApi()

    await expect(
      shell?.openInExternalEditor?.({
        path: 'C:\\repo\\notes.md',
        ownerHostId: 'ssh:work'
      })
    ).resolves.toEqual({ ok: false, reason: 'remote-editor-unsupported' })
  })

  it('maps a native invocation failure to launch-failed', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_open_external_editor'
        ? Promise.reject(new Error('native command failed'))
        : Promise.resolve(null)
    )
    const { createTauriNativeShellApi } = await import('./tauri-native-shell-api')
    const shell = createTauriNativeShellApi()

    await expect(
      shell?.openInExternalEditor?.({ path: 'C:\\repo', ownerHostId: 'local' })
    ).resolves.toEqual({ ok: false, reason: 'launch-failed' })
  })

  it('maps native local log tail reads, watches, and change events', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_read_local_log_tail'
        ? Promise.resolve({
            contentBase64: 'bGluZQo=',
            nextByteOffset: 5,
            fileSize: 5,
            fileIdentity: 'identity',
            hasMore: false,
            reset: false
          })
        : Promise.resolve(null)
    )
    const { createTauriNativeLocalLogTailApi } = await import('./tauri-native-local-log-tail-api')
    const fs = createTauriNativeLocalLogTailApi()
    const onChanged = vi.fn()
    const unsubscribe = fs.onLocalLogTailChanged?.(onChanged)
    await expect(
      fs.readLocalLogTail?.({ filePath: 'C:\\orca.log', fromByteOffset: 0 })
    ).resolves.toMatchObject({ nextByteOffset: 5, fileIdentity: 'identity' })
    await fs.startLocalLogTail?.({ filePath: 'C:\\orca.log', subscriptionId: 'tail-1' })
    host.emit('fs:localLogTailChanged', { subscriptionId: 'tail-1', eventType: 'change' })
    expect(onChanged).toHaveBeenCalledWith({ subscriptionId: 'tail-1', eventType: 'change' })
    await fs.stopLocalLogTail?.({ subscriptionId: 'tail-1' })
    unsubscribe?.()
    expect(host.invoke.mock.calls.map(([command]) => command)).toEqual([
      'poc_read_local_log_tail',
      'poc_start_local_log_tail',
      'poc_stop_local_log_tail'
    ])
  })

  it('imports local files through the native authorization boundary', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_import_external_paths'
        ? Promise.resolve({
            results: [
              {
                sourcePath: 'C:\\outside\\shot.png',
                status: 'imported',
                destPath: 'C:\\repo\\shot.png',
                kind: 'file',
                renamed: false
              }
            ]
          })
        : Promise.resolve(null)
    )
    const { createTauriNativeFilesystemApi } = await import('./tauri-native-bridge')
    const fs = createTauriNativeFilesystemApi()

    await expect(
      fs.importExternalPaths?.({
        sourcePaths: ['C:\\outside\\shot.png'],
        destDir: 'C:\\repo',
        ensureDir: true,
        access: { kind: 'document-folder', documentPath: 'C:\\repo\\note.md' }
      })
    ).resolves.toMatchObject({ results: [{ status: 'imported', renamed: false }] })
    expect(host.invoke).toHaveBeenCalledWith('poc_import_external_paths', {
      args: {
        sourcePaths: ['C:\\outside\\shot.png'],
        destDir: 'C:\\repo',
        ensureDir: true,
        access: { kind: 'document-folder', documentPath: 'C:\\repo\\note.md' }
      }
    })
  })
})

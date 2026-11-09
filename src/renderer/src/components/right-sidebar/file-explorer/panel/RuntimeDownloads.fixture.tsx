import { Copy, Download, File, MonitorDown, Pencil, Search, SquareTerminal } from 'lucide-react'
import { FixtureCodeBackdrop } from '../../../../component-fixtures/FixtureCodeBackdrop'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../../ui/dropdown-menu'
import { RuntimeDownloadToast, type RuntimeDownloadToastState } from './runtime-download-toast'

const noop = (): void => {}
const MB = 1024 * 1024

function toastFixture(state: RuntimeDownloadToastState) {
  return defineFixture({
    width: 380,
    render: () => (
      <div className="bg-background p-3">
        <RuntimeDownloadToast
          state={state}
          revealLabel="Reveal in Finder"
          onAction={noop}
          onDismiss={noop}
        />
      </div>
    )
  })
}

// Mirrors the file explorer row menu around the new entries (a dropdown, since a context menu
// cannot be held open in a fixture).
function menuFixture(kind: 'file' | 'folder') {
  return defineFixture({
    width: 300,
    render: () => (
      <div className="relative h-[250px] overflow-hidden bg-background">
        <FixtureCodeBackdrop />
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger className="absolute top-2 left-2 size-px" />
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuItem>
              <SquareTerminal />
              Open in Terminal
            </DropdownMenuItem>
            {kind === 'file' ? (
              <DropdownMenuItem>
                <File />
                View File
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem>
              <Download />
              {kind === 'file' ? 'Download' : 'Download as ZIP…'}
            </DropdownMenuItem>
            {kind === 'file' ? (
              <DropdownMenuItem>
                <MonitorDown />
                Open on This Computer
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem>
                <Search />
                Find in Folder
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <Copy />
              Copy Path
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Pencil />
              Rename
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  })
}

export const menuFile = menuFixture('file')
export const menuFolder = menuFixture('folder')

export const fileProgress = toastFixture({
  kind: 'progress',
  intent: 'save',
  itemKind: 'file',
  name: 'random-200mb.bin',
  snapshot: {
    downloadId: 'f',
    phase: 'transferring',
    receivedBytes: 87 * MB,
    totalBytes: 200 * MB,
    processedBytes: 87 * MB,
    bytesPerSecond: 14.2 * MB
  }
})
export const folderCollecting = toastFixture({
  kind: 'progress',
  intent: 'save',
  itemKind: 'folder',
  name: 'smallfiles.zip',
  snapshot: null
})
export const folderProgress = toastFixture({
  kind: 'progress',
  intent: 'save',
  itemKind: 'folder',
  name: 'smallfiles.zip',
  snapshot: {
    downloadId: 'd',
    phase: 'transferring',
    receivedBytes: 1.1 * MB,
    totalBytes: 2.4 * MB,
    processedBytes: 1.6 * MB,
    fileCount: 5000,
    bytesPerSecond: 1.2 * MB
  }
})
export const openProgress = toastFixture({
  kind: 'progress',
  intent: 'open',
  itemKind: 'file',
  name: 'build-output.zip',
  snapshot: {
    downloadId: 'o',
    phase: 'transferring',
    receivedBytes: 0.6 * MB,
    totalBytes: 1.9 * MB,
    processedBytes: 0.6 * MB,
    bytesPerSecond: 5.4 * MB
  }
})
export const fileDone = toastFixture({
  kind: 'done',
  itemKind: 'file',
  name: 'random-200mb.bin',
  bytes: 200 * MB,
  elapsedMs: 14_300
})
export const folderDone = toastFixture({
  kind: 'done',
  itemKind: 'folder',
  name: 'smallfiles.zip',
  bytes: 0.7 * MB,
  elapsedMs: 2_400,
  fileCount: 5000,
  excludedDefaultDirs: true
})
export const folderDoneSkipped = toastFixture({
  kind: 'done',
  itemKind: 'folder',
  name: 'logs.zip',
  bytes: 3.2 * MB,
  elapsedMs: 1_800,
  fileCount: 1,
  skippedCount: 2
})
export const errorDisconnected = toastFixture({
  kind: 'failed',
  intent: 'save',
  itemKind: 'file',
  name: 'random-200mb.bin',
  code: 'disconnected',
  place: 'sandbox'
})
export const errorTooLarge = toastFixture({
  kind: 'failed',
  intent: 'save',
  itemKind: 'folder',
  name: 'datasets',
  code: 'too_large',
  place: 'sandbox'
})
export const errorTooLargeToOpen = toastFixture({
  kind: 'failed',
  intent: 'open',
  itemKind: 'file',
  name: 'model.safetensors',
  code: 'too_large',
  place: 'sandbox'
})
export const errorOldSandbox = toastFixture({
  kind: 'failed',
  intent: 'save',
  itemKind: 'folder',
  name: 'src',
  code: 'host_update_required',
  place: 'sandbox'
})
export const errorNotFound = toastFixture({
  kind: 'failed',
  intent: 'save',
  itemKind: 'file',
  name: 'report.pdf',
  code: 'not_found',
  place: 'sandbox'
})
export const errorNoApp = toastFixture({ kind: 'no_app', name: 'trace.perfetto' })

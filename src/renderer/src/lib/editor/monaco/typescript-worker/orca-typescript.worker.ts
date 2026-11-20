import { initialize } from 'monaco-editor/esm/vs/common/initialize.js'
import { OrcaTypeScriptWorker } from './orca-typescript-worker'

// Mirrors monaco-editor's ts.worker entry, which constructs its own TypeScriptWorker class.
self.onmessage = () => {
  initialize((context, createData) => new OrcaTypeScriptWorker(context, createData))
}

import type { editor } from 'monaco-editor'

export type VimAttachment = { dispose: () => void }

type WriteRef = { readonly current: () => void }
type VimExRegistrar = (name: string, prefix: string, command: (adapter: object) => void) => void

const adapterWrites = new WeakMap<object, WriteRef>()
let exRegistered = false

const noopAttachment: VimAttachment = {
  dispose() {}
}

export function shouldAttachEditorVim(args: {
  preset: 'default' | 'vim'
  readOnly: boolean
  autoHeight: boolean
}): boolean {
  return args.preset === 'vim' && !args.readOnly && !args.autoHeight
}

function readDefineEx(vimMode: object): VimExRegistrar {
  if (!('Vim' in vimMode)) {
    throw new Error('monaco-vim is missing Vim.defineEx')
  }
  const vim = vimMode.Vim
  if (typeof vim !== 'object' || vim === null || !('defineEx' in vim)) {
    throw new Error('monaco-vim is missing Vim.defineEx')
  }
  const defineEx = vim.defineEx
  if (typeof defineEx !== 'function') {
    throw new Error('monaco-vim is missing Vim.defineEx')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: monaco-vim's runtime VimMode is CodeMirror and exposes Vim.defineEx; the published type omits .Vim.
  return defineEx as VimExRegistrar
}

function findWidgetOpen(container: HTMLElement): boolean {
  const widget = container.querySelector('.find-widget')
  return widget !== null && widget.getAttribute('aria-hidden') !== 'true'
}

export async function attachMonacoVimMode(args: {
  editor: editor.IStandaloneCodeEditor
  statusNode: HTMLElement
  onWriteRef: { readonly current: () => void }
  signal: AbortSignal
}): Promise<VimAttachment> {
  if (args.signal.aborted) {
    return noopAttachment
  }

  let escapeCleanup: (() => void) | null = null
  let vim: { dispose: () => void } | null = null
  const codeEditor = args.editor

  const dispose = (): void => {
    escapeCleanup?.()
    escapeCleanup = null
    if (vim) {
      adapterWrites.delete(vim)
    }
    const attached = vim
    vim = null
    attached?.dispose()
  }

  try {
    // Why: Default keybindings must not load monaco-vim; the specifier is fixed, the load is not.
    const monacoVim = await import('monaco-vim')
    if (args.signal.aborted) {
      return noopAttachment
    }

    const container = codeEditor.getContainerDomNode()
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !findWidgetOpen(container)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      codeEditor.trigger('keyboard', 'closeFindWidget', null)
    }
    container.addEventListener('keydown', onEscape, true)
    escapeCleanup = () => container.removeEventListener('keydown', onEscape, true)

    vim = monacoVim.initVimMode(codeEditor, args.statusNode)
    adapterWrites.set(vim, args.onWriteRef)
    if (args.signal.aborted) {
      dispose()
      return noopAttachment
    }

    if (!exRegistered) {
      readDefineEx(monacoVim.VimMode)('write', 'w', (adapter) => {
        adapterWrites.get(adapter)?.current()
      })
      exRegistered = true
    }

    if (!args.statusNode.textContent?.includes('--NORMAL--')) {
      container.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true
        })
      )
    }

    return { dispose }
  } catch (error) {
    dispose()
    console.error(
      'Vim keybindings failed to attach',
      error instanceof Error ? error.message : 'unknown'
    )
    throw error
  }
}

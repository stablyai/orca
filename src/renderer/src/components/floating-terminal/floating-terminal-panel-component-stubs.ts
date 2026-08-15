// Render stubs for the heavy panes/primitives the floating panel composes; the tests assert on
// element type names and props, never on rendered output.

export function createTabBarModule() {
  return {
    default: function TabBar() {
      return null
    }
  }
}

export function createTerminalPaneModule() {
  return {
    default: function TerminalPane() {
      return null
    }
  }
}

export function createBrowserPaneModule() {
  return {
    default: function BrowserPane() {
      return null
    }
  }
}

export function createEmulatorPaneModule() {
  return {
    default: function EmulatorPane() {
      return null
    }
  }
}

export function createEditorPanelModule() {
  return {
    default: function EditorPanel() {
      return null
    }
  }
}

export function createButtonModule() {
  return {
    Button: function Button() {
      return null
    }
  }
}

export function createDialogModule() {
  return {
    Dialog: function Dialog(props: { children?: unknown }) {
      return props.children
    },
    DialogContent: function DialogContent(props: { children?: unknown }) {
      return props.children
    },
    DialogDescription: function DialogDescription(props: { children?: unknown }) {
      return props.children
    },
    DialogFooter: function DialogFooter(props: { children?: unknown }) {
      return props.children
    },
    DialogHeader: function DialogHeader(props: { children?: unknown }) {
      return props.children
    },
    DialogTitle: function DialogTitle(props: { children?: unknown }) {
      return props.children
    }
  }
}

export function createOrchestrationDialogModule() {
  return {
    FloatingTerminalOrchestrationDialog: function FloatingTerminalOrchestrationDialog() {
      return null
    }
  }
}

export function createResizeHandlesModule() {
  return {
    FloatingTerminalResizeHandles: function FloatingTerminalResizeHandles() {
      return null
    }
  }
}

export function createToggleButtonModule() {
  return {
    FloatingTerminalToggleButton: function FloatingTerminalToggleButton() {
      return null
    }
  }
}

export function createWindowControlsModule() {
  return {
    FloatingTerminalWindowControls: function FloatingTerminalWindowControls() {
      return null
    }
  }
}

export function createShortcutKeyComboModule() {
  return {
    ShortcutKeyCombo: function ShortcutKeyCombo() {
      return null
    }
  }
}

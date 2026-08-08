// Posts a chord the way a human types it: the modifier as its own key event, not as a flag
// System Events folds into the character key. Only this form produces the modifier's own
// press/release, which is what a release-driven recovery would key off.
// Usage: swift post-modifier-chord.swift <modifierKeyCode> <targetKeyCode>

import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 3,
  let modifierKey = CGKeyCode(arguments[1]),
  let targetKey = CGKeyCode(arguments[2])
else {
  FileHandle.standardError.write(
    Data("usage: post-modifier-chord.swift <modifierKeyCode> <targetKeyCode>\n".utf8))
  exit(2)
}

let modifierFlag: CGEventFlags =
  switch modifierKey {
  case 55, 54: .maskCommand
  case 58, 61: .maskAlternate
  case 59, 62: .maskControl
  default: []
  }

let source = CGEventSource(stateID: .hidSystemState)

func post(_ key: CGKeyCode, down: Bool, flags: CGEventFlags) {
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else {
    exit(3)
  }
  event.flags = flags
  event.post(tap: .cghidEventTap)
  usleep(80_000)
}

post(modifierKey, down: true, flags: modifierFlag)
post(targetKey, down: true, flags: modifierFlag)
post(targetKey, down: false, flags: modifierFlag)
post(modifierKey, down: false, flags: [])
exit(0)

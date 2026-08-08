import Carbon

guard CommandLine.arguments.count == 2 else {
  exit(2)
}

let properties = [kTISPropertyInputSourceID: CommandLine.arguments[1] as CFString] as CFDictionary
let sources = TISCreateInputSourceList(properties, true).takeRetainedValue() as! [TISInputSource]
guard !sources.isEmpty else {
  exit(3)
}

func boolProperty(_ source: TISInputSource, _ key: CFString) -> Bool {
  guard let raw = TISGetInputSourceProperty(source, key) else { return false }
  return unsafeBitCast(raw, to: CFBoolean.self) == kCFBooleanTrue
}

// Why: one id can expose several entries — a third-party IME publishes a non-selectable
// parent alongside the selectable mode, and `sources.first` can return the parent, which
// then fails TISSelectInputSource with paramErr (-50). Qingg is the case that found this.
let selectable = sources.filter { boolProperty($0, kTISPropertyInputSourceIsSelectCapable) }
guard let source = selectable.first ?? sources.first else {
  exit(3)
}

// Enable every entry for the id, not just the selected one: selecting a mode whose parent
// is still disabled also fails with -50.
for candidate in sources {
  TISEnableInputSource(candidate)
}

exit(TISSelectInputSource(source) == noErr ? 0 : 4)

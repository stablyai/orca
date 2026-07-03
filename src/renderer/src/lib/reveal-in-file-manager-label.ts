// Platform-appropriate label for the OS "reveal a file in its containing
// folder" action: macOS → Finder, Linux → containing folder, Windows →
// File Explorer. Shared so every reveal affordance shows the same wording.
const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

export const revealInFileManagerLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

// Share high-churn exclusions across desktop and runtime watchers, following VS Code's recursive-watch defaults.
export const WATCHER_IGNORE_DIRS: string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'target',
  '.venv',
  '__pycache__',
  '.dart_tool',
  '.gradle',
  '.turbo'
]

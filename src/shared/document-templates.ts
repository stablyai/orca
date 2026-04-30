export type MarkdownTemplateVariables = {
  title: string
  filename: string
  date: string
  time: string
  datetime: string
}

function getLastSegment(path: string): string {
  const slashIndex = path.lastIndexOf('/')
  return slashIndex === -1 ? path : path.slice(slashIndex + 1)
}

function getExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf('.')
  if (lastDotIndex <= 0 || lastDotIndex === filename.length - 1) {
    return ''
  }
  return filename.slice(lastDotIndex).toLowerCase()
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function getTitleFromMarkdownPath(relativePath: string): string {
  const filename = getLastSegment(relativePath.replace(/[\\/]+/g, '/'))
  const extension = getExtension(filename)
  return extension ? filename.slice(0, -extension.length) : filename
}

export function getMarkdownTemplateVariables(args: {
  title: string
  filename: string
  now?: Date
}): MarkdownTemplateVariables {
  const now = args.now ?? new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`

  return {
    title: args.title,
    filename: args.filename,
    date,
    time,
    datetime: `${date} ${time}`
  }
}

export function renderMarkdownTemplate(
  content: string,
  variables: MarkdownTemplateVariables
): string {
  return content.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (match, key: string) => {
    if (key === 'title' || key === 'filename' || key === 'date' || key === 'time') {
      return variables[key]
    }
    if (key === 'datetime') {
      return variables.datetime
    }
    return match
  })
}
